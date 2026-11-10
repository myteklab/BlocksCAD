// Click a part of the 3D model to select the block that made it, and select a block to light up
// the part it made.
//
// While Render builds the code, every shape-making block is wrapped in bs_tag(n=K), where K
// indexes Pick.table, a list of block ids for this render. The worker stamps K on each face that
// shape produced (js/extra-modules.js), so after a difference the walls of a hole belong to the
// cylinder that cut it. The Code tab and the OpenSCAD export never see bs_tag.

(function () {
  // Blocks whose output is new faces. Transforms and set operations only move or combine faces
  // that already carry a tag, so they are left out.
  var SHAPE_BLOCKS = [
    'sphere', 'cube', 'cylinder', 'torus', 'twistytorus', 'simple_cylinder',
    'circle', 'square', 'polygon', 'triangle_sss', 'triangle_ssa', 'triangle_asa',
    'triangle_sss_3d', 'triangle_ssa_3d', 'triangle_asa_3d',
    'bs_text', 'bs_3dtext', 'stl_import', 'z_equals_plotter',
    'linearextrude', 'rotateextrude', 'rotateextrudetwist', 'hull',
    'bs_regular_polygon', 'bs_star', 'bs_offset', 'bs_round_edges', 'bs_shell', 'bs_projection'
  ];
  var HIGHLIGHT = new THREE.Color(1, 0.62, 0.1);
  var DIM = 0.5;

  var Pick = { table: [] };
  window.BlockPick = Pick;

  SHAPE_BLOCKS.forEach(function (type) {
    var gen = Blockly.OpenSCAD[type];
    if (!gen) return;
    Blockly.OpenSCAD[type] = function (block) {
      var code = gen.apply(this, arguments);
      if (!Blockscad.renderingNow || typeof code !== 'string' || !code.trim()) return code;
      Pick.table.push(block.id);
      return 'bs_tag(n=' + (Pick.table.length - 1) + '){\n' + code + '\n}';
    };
  });

  // extra-blocks.js sets Blockscad.renderingNow around the same call.
  var doRender = Blockscad.doRender;
  Blockscad.doRender = function () {
    Pick.table = [];
    return doRender.apply(this, arguments);
  };

  function viewer() {
    return Blockscad.gProcessor && Blockscad.gProcessor.viewer;
  }

  // Face i of the viewer's geometry -> the polygon it came from. csgToGeometry fans each polygon
  // into (vertices - 2) faces, in polygon order, so a running count gives the mapping.
  var faceMap = null;
  function facesOf(mesh) {
    if (faceMap && faceMap.mesh === mesh) return faceMap;
    var obj = Blockscad.gProcessor.currentObject;
    if (!(obj instanceof CSG) || !mesh || !mesh.geometry || !mesh.geometry.faces) return null;
    var polys = obj.canonicalized().polygons;
    var tags = [];
    for (var p = 0; p < polys.length; p++) {
      var tag = polys[p].shared && polys[p].shared.blockTag;
      for (var k = 2; k < polys[p].vertices.length; k++) tags.push(tag === undefined ? -1 : tag);
    }
    if (tags.length !== mesh.geometry.faces.length) return null;
    faceMap = { mesh: mesh, tags: tags, base: mesh.geometry.faces.map(function (f) { return f.color.clone(); }) };
    return faceMap;
  }

  function blockForTag(tag) {
    var id = Pick.table[tag];
    var block = id && Blockscad.workspace.getBlockById(id);
    if (!block) return null;
    // A block hidden inside a collapsed block can't be shown, so select the collapsed one.
    var collapsed = block.collapsedParents && block.collapsedParents();
    return collapsed && collapsed.length ? collapsed[collapsed.length - 1] : block;
  }

  function scrollIntoView(block) {
    var ws = Blockscad.workspace;
    if (!ws.scrollbar) return;
    var m = ws.getMetrics();
    var xy = block.getRelativeToSurfaceXY();
    var hw = block.getHeightWidth();
    var left = xy.x * ws.scale - m.viewLeft;
    var top = xy.y * ws.scale - m.viewTop;
    var w = hw.width * ws.scale, h = Math.min(hw.height * ws.scale, m.viewHeight);
    if (left >= 0 && top >= 0 && left + w <= m.viewWidth && top + h <= m.viewHeight) return;
    var cx = (xy.x + hw.width / 2) * ws.scale;
    var cy = xy.y * ws.scale + h / 2;
    ws.scrollbar.set(cx - m.contentLeft - m.viewWidth / 2, cy - m.contentTop - m.viewHeight / 2);
  }

  function tagsUnder(block) {
    var ids = {};
    block.getDescendants().forEach(function (b) { ids[b.id] = 1; });
    var tags = {};
    Pick.table.forEach(function (id, i) { if (ids[id]) tags[i] = 1; });
    return tags;
  }

  // Face colors go through the lights, so a lit part on a wall facing away (the inside of a
  // hole) came out dark brown. An unlit see-through layer over the same faces shows at any angle.
  function clearOverlay(v) {
    var o = v._pickOverlay;
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    o.material.dispose();
    v._pickOverlay = null;
  }

  function addOverlay(v, faceList) {
    var g = new THREE.Geometry();
    g.vertices = v.mesh.geometry.vertices;
    g.faces = faceList;
    var o = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: HIGHLIGHT, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    }));
    o.position.copy(v.mesh.position);
    o.quaternion.copy(v.mesh.quaternion);
    o.scale.copy(v.mesh.scale);
    v.mesh.parent.add(o);
    v._pickOverlay = o;
  }

  function paint(selected) {
    var v = viewer();
    if (!v) return;
    clearOverlay(v);
    if (!v.mesh) return;
    var map = facesOf(v.mesh);
    if (!map) return;
    var tags = selected ? tagsUnder(selected) : null;
    var faces = v.mesh.geometry.faces;
    var lit = [];
    if (tags) for (var k = 0; k < faces.length; k++) if (tags[map.tags[k]]) lit.push(faces[k].clone());
    for (var i = 0; i < faces.length; i++) {
      var c = faces[i].color.copy(map.base[i]);
      if (!lit.length) continue;
      if (tags[map.tags[i]]) c.lerp(HIGHLIGHT, 0.85);
      else c.multiplyScalar(DIM);
    }
    v.mesh.geometry.colorsNeedUpdate = true;
    if (lit.length) addOverlay(v, lit);
    if (v.onDraw) v.onDraw();
  }

  function selectedBlock() {
    return Blockly.selected && Blockly.selected.workspace === Blockscad.workspace ? Blockly.selected : null;
  }

  function pickAt(clientX, clientY) {
    var v = viewer();
    if (!v || !v.mesh || !v.camera) return;
    var map = facesOf(v.mesh);
    if (!map) return;
    var rect = v.renderer.domElement.getBoundingClientRect();
    var ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    // The orbit controls ease the camera between frames, so use where it is now, not where the
    // last frame drew it.
    v.camera.updateMatrixWorld();
    v.mesh.updateMatrixWorld(true);
    var ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, v.camera);
    var hit = ray.intersectObject(v.mesh, false)[0];
    if (!hit) {
      if (selectedBlock()) Blockly.selected.unselect();
      paint(null);
      return;
    }
    var block = blockForTag(map.tags[hit.faceIndex]);
    if (!block) return;
    block.select();
    scrollIntoView(block);
    paint(block);
  }

  // A click is a press and release that barely moved. Anything longer is the camera being turned.
  function watchClicks() {
    var v = viewer();
    var canvas = v && v.renderer && v.renderer.domElement;
    if (!canvas || canvas._blockPick) return !!canvas;
    canvas._blockPick = true;
    var down = null;
    canvas.addEventListener('pointerdown', function (e) {
      down = e.isPrimary && e.button === 0 ? { x: e.clientX, y: e.clientY, t: Date.now() } : null;
    });
    canvas.addEventListener('pointerup', function (e) {
      if (!down) return;
      var moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
      var quick = Date.now() - down.t < 500;
      down = null;
      if (moved < 6 && quick) pickAt(e.clientX, e.clientY);
    });
    canvas.title = 'Click a part to find its block';
    return true;
  }

  window.addEventListener('load', function () {
    document.body.addEventListener('renderDone', function () {
      faceMap = null;
      // The mesh is new after every render, so repaint the selected block's part on it.
      setTimeout(function () { paint(selectedBlock()); }, 150);
    });
    var tries = 0;
    var timer = setInterval(function () {
      if (watchClicks() || ++tries > 60) clearInterval(timer);
    }, 500);
    var hooked = setInterval(function () {
      if (!Blockscad.workspace) return;
      clearInterval(hooked);
      Blockscad.workspace.addChangeListener(function (e) {
        if (e.type === Blockly.Events.UI && e.element === 'selected') paint(selectedBlock());
      });
    }, 300);
  });
})();
