// Replaces Blockscad.parseBlockscadScriptASync from the viewer bundle.
//
// Upstream built a fresh worker for every render, so each click on Render re-downloaded nothing
// but did re-compile ~500 KB of libraries and re-parse every font. This keeps one worker warm and
// reuses it. The worker also loads Manifold (vendor/manifold) once, which fast-booleans.js uses
// for the slow CSG operations, and it sends back which block made each face (click-to-highlight).
//
// Stopping a render still kills the worker, as before. The next render starts a new one.

(function () {
  var LIBS = [
    'dist/viewer_compressed-f7940b1422.js',
    'opentype/dist/opentype.min.js',
    'blockscad/underscore.js',
    'dist/openscad-openjscad-translator-x1.js',
    'dist/csg_compressed-ea5407529e.js',
    'dist/formats_compressed-5279859f68.js',
    'js/fast-booleans.js?v=1',
    'js/extra-modules.js?v=2'
  ];
  var MANIFOLD = 'vendor/manifold/manifold.js';

  // Runs inside the worker. Kept as a real function so it reads as code, then sent as text.
  function workerMain() {
    /* global LIBS_ABS, MANIFOLD_ABS */
    LIBS_ABS.forEach(function (url) { importScripts(url); });

    var fontCache = {};

    // Manifold is optional. If the import fails or hangs, renders go ahead on csg.js alone.
    var ready = new Promise(function (resolve) {
      var done = false;
      function finish(note) {
        if (done) return;
        done = true;
        self.postMessage({ cmd: 'engine', fast: FastBooleans.active(), note: note || '' });
        resolve();
      }
      setTimeout(function () { finish('manifold load timed out'); }, 10000);
      try {
        import(MANIFOLD_ABS).then(function (mod) {
          return mod.default();
        }).then(function (wasm) {
          wasm.setup();
          FastBooleans.install(wasm);
          finish();
        }, function (e) {
          finish('manifold failed: ' + (e && e.message || e));
        });
      } catch (e) {
        finish('manifold unsupported: ' + (e && e.message || e));
      }
    });

    function render(msg) {
      Blockscad.resolution = msg.resolution;
      Blockscad.csg_filename = msg.csg_filename;
      Blockscad.csg_commands = msg.csg_commands;
      Blockscad.fonts = {};
      for (var i = 0; i < msg.fontkeys.length; i++) {
        var key = msg.fontkeys[i];
        if (!fontCache[key]) fontCache[key] = opentype.parse(msg.fontdata[i]);
        Blockscad.fonts[key] = fontCache[key];
      }

      var js;
      try {
        js = openscadOpenJscadParser.parse(msg.code);
        if (!js || !js.length) throw new Error('parser produced no output at all');
      } catch (e) {
        self.postMessage({ cmd: 'errorParse', id: msg.id, err: e.toString() });
        return;
      }
      self.postMessage({ cmd: 'parsed', id: msg.id });

      var started = Date.now();
      FastBooleans.stats.fast = 0;
      FastBooleans.stats.fallback = 0;
      FastBooleans.stats.lastError = '';
      try {
        var parts = new Function(js)();
        if (typeof parts[0] !== 'object' || !(parts[0] instanceof CSG || parts[0] instanceof CAG)) throw new Error('Nothing to Render!');
        var solid = parts.length === 1 ? parts[0] : parts[0].union(parts.slice(1));
        var blockTags = null;
        if (solid instanceof CSG) {
          // toCompactBinary lists each "shared" object once, in the order the faces first use
          // it. Walk the faces the same way so blockTags[i] belongs to shared[i].
          solid = solid.canonicalized();
          blockTags = [];
          var seen = {};
          solid.polygons.forEach(function (p) {
            var tag = p.shared.getTag();
            if (seen[tag]) return;
            seen[tag] = 1;
            blockTags.push(p.shared.blockTag === undefined ? -1 : p.shared.blockTag);
          });
        }
        self.postMessage({
          cmd: 'finalMesh',
          id: msg.id,
          result: solid.toCompactBinary(),
          blockTags: blockTags,
          ms: Date.now() - started,
          fast: FastBooleans.stats.fast,
          fallback: FastBooleans.stats.fallback,
          fallbackWhy: FastBooleans.stats.lastError
        });
      } catch (e) {
        self.postMessage({ cmd: 'error', id: msg.id, err: e.toString() });
      }
    }

    self.addEventListener('message', function (e) {
      if (e.data && e.data.cmd === 'render') ready.then(function () { render(e.data); });
    });
  }

  var warm = null;
  var nextId = 1;

  function absolute(path) {
    return new URL(path, document.baseURI).href;
  }

  function startWorker() {
    var source = 'var LIBS_ABS = ' + JSON.stringify(LIBS.map(absolute)) + ';\n' +
      'var MANIFOLD_ABS = ' + JSON.stringify(absolute(MANIFOLD)) + ';\n' +
      '(' + workerMain.toString() + ')();\n';
    var url = Blockscad.textToBlobUrl(source);
    var worker = new Worker(url);
    var state = { worker: worker, onMessage: null };
    worker.onmessage = function (e) {
      if (e.data && e.data.cmd === 'engine') {
        Blockscad.renderEngine = e.data;
        return;
      }
      if (state.onMessage) state.onMessage(e);
    };
    worker.onerror = function (e) {
      if (state.onError) state.onError(e);
    };
    return state;
  }

  function fail(callback, text) {
    callback(text, null);
  }

  Blockscad.parseBlockscadScriptASync = function (code, callback) {
    if (!window.Worker) throw new Error("Your browser doesn't support Web Workers. Please try the Chrome or Firefox browser instead.");
    if (!warm) warm = startWorker();
    var state = warm;
    var id = nextId++;

    state.onMessage = function (e) {
      var d = e.data;
      if (!d || d.id !== id) return;
      if (d.cmd === 'finalMesh') {
        var obj;
        if (d.result['class'] === 'CSG') {
          obj = CSG.fromCompactBinary(d.result);
          if (d.blockTags) {
            var idx = d.result.polygonSharedIndexes;
            for (var i = 0; i < obj.polygons.length; i++) obj.polygons[i].shared.blockTag = d.blockTags[idx[i]];
          }
        } else if (d.result['class'] === 'CAG') {
          obj = CAG.fromCompactBinary(d.result);
        } else {
          return fail(callback, 'cannot parse final result');
        }
        Blockscad.lastRenderStats = { ms: d.ms, fast: d.fast, fallback: d.fallback, fallbackWhy: d.fallbackWhy };
        callback('finalMesh', obj);
      } else if (d.cmd === 'error') {
        fail(callback, d.err);
      } else if (d.cmd === 'errorParse') {
        $('#error-message').html(d.err);
        $('#error-message').addClass('has-error');
        fail(callback, d.err);
      } else if (d.cmd === 'parsed') {
        $('#render-ongoing').html(Blockscad.Msg.RENDER_IN_PROGRESS + '<img id=busy src="imgs/busy2.gif">');
      }
    };
    state.onError = function (e) {
      // A crash inside the worker leaves it in an unknown state, so the next render starts fresh.
      if (warm === state) warm = null;
      try { state.worker.terminate(); } catch (err) {}
      fail(callback, 'Error in line ' + e.lineno + ': ' + e.message);
    };

    var keys = [];
    var data = [];
    for (var k in Blockscad.fonts) {
      keys.push(k);
      data.push(Blockscad.fonts[k]);
    }
    state.worker.postMessage({
      cmd: 'render',
      id: id,
      code: code,
      resolution: Blockscad.resolution,
      fontkeys: keys,
      fontdata: data,
      csg_filename: Blockscad.csg_filename,
      csg_commands: Blockscad.csg_commands
    });

    // The viewer calls terminate() on this to stop a render.
    return {
      terminate: function () {
        if (warm === state) warm = null;
        state.onMessage = null;
        state.worker.terminate();
      }
    };
  };

  // Start loading the worker and Manifold while the student is still placing blocks.
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (!warm && window.Worker && window.Blockscad && Blockscad.textToBlobUrl) warm = startWorker();
    }, 1500);
  });
})();
