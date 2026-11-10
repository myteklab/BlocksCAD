// What happens when a project is opened. Loaded by index.html and platform.html, not by
// preview.html, which loads and renders its project itself.

(function () {
  // Upstream backs the workspace up to localStorage when the page unloads and restores it on the
  // next start, with Blockly events on. Inside a frame the project always arrives from the page
  // around it, so that restore only ever loaded the previous session's blocks for a moment,
  // and clearing them away counted as an edit: every reopened project showed as unsaved. On a
  // shared computer it was also the previous student's blocks. Opened directly, BlocksCAD keeps
  // upstream's behavior.
  if (window.parent !== window && window.BlocklyStorage) {
    BlocklyStorage.backupOnUnload = function () {};
    BlocklyStorage.restoreBlocks = function () {};
    try {
      localStorage.removeItem(window.location.href.split('#')[0].split('?')[0]);
    } catch (e) {}
  }

  // Draw a project as soon as it is opened. Upstream left the viewer empty until Render, which
  // looked like the model was lost, and a save before rendering stored an empty grid as the
  // project's picture. Only a whole project landing in an empty workspace counts: an import
  // adds to blocks already there, and the color scheme switch reloads with recordHistory off.
  var domToWorkspace = Blockly.Xml.domToWorkspace;
  var pending = null;
  Blockly.Xml.domToWorkspace = function (a, b) {
    // Upstream calls this with the arguments in both orders.
    var ws = a && a.getTopBlocks ? a : b;
    var wasEmpty = !!(ws && ws.getTopBlocks && ws.getTopBlocks(false).length === 0);
    var out = domToWorkspace.apply(this, arguments);
    if (wasEmpty && window.Blockscad && ws === Blockscad.workspace && Blockscad.recordHistory !== false) {
      clearTimeout(pending);
      pending = setTimeout(renderOpenedProject, 400);
    }
    return out;
  };

  function renderOpenedProject() {
    var proc = Blockscad.gProcessor;
    if (!proc || proc.processing) return;
    var shapes = Blockscad.workspace.getTopBlocks(false).some(function (b) { return Blockscad.stackIsShape(b); });
    if (shapes) Blockscad.doRender();
  }
})();
