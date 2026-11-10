// Blocks that upstream BlocksCAD does not have: offset, round edges, hollow, flatten
// (projection), resize, put on the floor, regular polygon and star. Their OpenSCAD calls are
// turned into geometry by js/extra-modules.js inside the render worker.
//
// Upstream decides whether a stack is 2D or 3D from a few block categories. Offset, round edges,
// hollow and flatten change the type partway down a stack (flatten takes 3D in and gives 2D out),
// so stacks holding one of them get a second pass at the end of this file. Every other stack
// keeps upstream's typing untouched.

(function () {
  var OS = Blockly.OpenSCAD;

  // Toolbox tabs are colored by position (Blockscad.Toolbox.setCatColors), so the Modify tab gets
  // its own slot in both color schemes, right after Set Ops where it sits in the toolbox.
  (function addModifyColor() {
    var T = Blockscad.Toolbox;
    if (T.allcats.indexOf('HEX_MODIFY') >= 0) return;
    var at = T.allcats.indexOf('HEX_SETOP') + 1;
    T.allcats.splice(at, 0, 'HEX_MODIFY');
    T.colorScheme.one.splice(at, 0, '#00897B');
    T.colorScheme.two.splice(at, 0, '#2a9d8f');
    T.whichCatsInAdv = T.allcats.map(function (c, i) { return i; });
    T.whichCatsInExp = T.whichCatsInAdv.slice();
    T.whichCatsInSimple = T.whichCatsInSimple.map(function (i) { return i >= at ? i + 1 : i; });
  })();
  function modifyColour() {
    return Blockscad.Toolbox.HEX_MODIFY || '#00897B';
  }

  function num(block, name, fallback) {
    var code = OS.valueToCode(block, name, OS.ORDER_ATOMIC);
    if (!code) {
      Blockscad.missingFields.push(block.id);
      return fallback;
    }
    return code;
  }

  // Positive-only inputs: a literal zero or less is marked on the block the way circle does.
  function positive(block, name, fallback) {
    var code = num(block, name, fallback);
    var target = block.getInput(name).connection.targetBlock();
    if (target && !isNaN(code) && Number(code) <= 0) Blockscad.illegalValue.push(target.id);
    return code;
  }

  function wrapStatement(block, head) {
    var body = OS.statementToCode(block, 'A');
    if (body !== '') body += '\n';
    for (var i = 1; i <= (block.plusCount_ || 0); i++) {
      var more = OS.statementToCode(block, 'PLUS' + i);
      if (more !== '') body += more + '\n';
    }
    var vars = OS.returnVarCode(block);
    return head + '{\n' + vars[0] + body + vars[1] + '}';
  }

  // Upstream shape blocks do not stack. A wrapper holds one shape, and its + button adds
  // another slot (PLUS1, PLUS2...). Same code as translate's, shared by every new wrapper.
  var plusSlots = {
    mutationToDom: function () {
      if (!this.plusCount_) return null;
      var m = document.createElement('mutation');
      m.setAttribute('plus', this.plusCount_);
      return m;
    },
    domToMutation: function (xml) {
      this.plusCount_ = parseInt(xml.getAttribute('plus'), 10) || 0;
      var check = this.getInput('A').connection.check_;
      for (var i = 1; i <= this.plusCount_; i++) this.appendStatementInput('PLUS' + i).setCheck(check);
      if (this.plusCount_ >= 1) this.setMutatorMinus(new Blockly.MutatorMinus(this));
    },
    updateShape_: function (dir) {
      if (dir === 1) {
        this.plusCount_++;
        this.appendStatementInput('PLUS' + this.plusCount_).setCheck(this.getInput('A').connection.check_);
      } else if (dir === -1) {
        this.removeInput('PLUS' + this.plusCount_);
        this.plusCount_--;
      }
      if (this.plusCount_ >= 1) {
        if (this.plusCount_ === 1 && dir === 1) {
          this.setMutatorMinus(new Blockly.MutatorMinus(this));
          this.render();
        }
      } else if (this.mutatorMinus) {
        this.mutatorMinus.dispose();
        this.mutatorMinus = null;
        this.render();
      }
    }
  };

  function wrapperBlock(def) {
    var init = def.init;
    def.init = function () {
      init.call(this);
      this.setMutatorPlus(new Blockly.MutatorPlus(this));
      this.plusCount_ = 0;
    };
    Object.keys(plusSlots).forEach(function (k) { def[k] = plusSlots[k]; });
    return def;
  }

  function numberInput(block, name, label) {
    return block.appendValueInput(name).setCheck('Number').appendField(label).setAlign(Blockly.ALIGN_RIGHT);
  }

  // ---- 2D shapes ----

  Blockly.Blocks.bs_regular_polygon = {
    init: function () {
      this.category = 'PRIMITIVE_CAG';
      this.setColour(Blockscad.Toolbox.HEX_2D_PRIMITIVE);
      this.appendDummyInput().appendField('polygon');
      numberInput(this, 'SIDES', 'sides');
      numberInput(this, 'RAD', 'radius');
      this.setInputsInline(true);
      this.setPreviousStatement(true, 'CAG');
      this.setTooltip('A shape with equal sides: 3 makes a triangle, 6 a hexagon, 8 a stop sign. Radius is center to corner.');
    }
  };
  OS.bs_regular_polygon = function (block) {
    return 'bs_regular_polygon(sides=' + positive(block, 'SIDES', 6) + ', r=' + positive(block, 'RAD', 10) + ');';
  };

  Blockly.Blocks.bs_star = {
    init: function () {
      this.category = 'PRIMITIVE_CAG';
      this.setColour(Blockscad.Toolbox.HEX_2D_PRIMITIVE);
      this.appendDummyInput().appendField('star');
      numberInput(this, 'POINTS', 'points');
      numberInput(this, 'R1', 'outer radius');
      numberInput(this, 'R2', 'inner radius');
      this.setInputsInline(true);
      this.setPreviousStatement(true, 'CAG');
      this.setTooltip('A star. Outer radius reaches the tips, inner radius reaches the dips between them.');
    }
  };
  OS.bs_star = function (block) {
    return 'bs_star(points=' + positive(block, 'POINTS', 5) + ', r1=' + positive(block, 'R1', 10) + ', r2=' + positive(block, 'R2', 5) + ');';
  };

  // ---- changes to a whole shape ----

  Blockly.Blocks.bs_offset = wrapperBlock({
    init: function () {
      this.category = 'BSX_2D_OP';
      this.setColour(modifyColour());
      this.appendDummyInput().appendField('offset').appendField(new Blockly.FieldDropdown([
        ['round corners', 'round'], ['sharp corners', 'sharp'], ['cut corners', 'chamfer']
      ]), 'MODE');
      numberInput(this, 'DIST', 'by');
      this.appendStatementInput('A').setCheck('CAG');
      this.setInputsInline(true);
      this.setPreviousStatement(true, 'CAG');
      this.setTooltip('Grows a 2D shape outward by this much, or shrinks it with a negative number. Good for rounded outlines, outlines of letters, and gaps between parts that fit together.');
    }
  });
  OS.bs_offset = function (block) {
    var d = num(block, 'DIST', 1);
    var mode = block.getFieldValue('MODE');
    var head = mode === 'round' ? 'offset(r=' + d + ')' : 'offset(delta=' + d + (mode === 'chamfer' ? ', chamfer=true' : '') + ')';
    return wrapStatement(block, head);
  };

  Blockly.Blocks.bs_round_edges = wrapperBlock({
    init: function () {
      this.category = 'BSX_3D_OP';
      this.setColour(modifyColour());
      this.appendDummyInput().appendField('round edges');
      numberInput(this, 'RAD', 'radius');
      this.appendStatementInput('A').setCheck('CSG');
      this.setInputsInline(true);
      this.setPreviousStatement(true, 'CSG');
      this.setTooltip('Rounds the outside edges and corners of a 3D shape and keeps its size. Inside corners stay sharp.');
    }
  });
  OS.bs_round_edges = function (block) {
    return wrapStatement(block, 'bs_round_edges(r=' + positive(block, 'RAD', 1) + ')');
  };

  Blockly.Blocks.bs_shell = wrapperBlock({
    init: function () {
      this.category = 'BSX_3D_OP';
      this.setColour(modifyColour());
      this.appendDummyInput().appendField('hollow out').appendField(new Blockly.FieldDropdown([
        ['closed', 'false'], ['open on top', 'true']
      ]), 'OPEN');
      numberInput(this, 'THICK', 'wall');
      this.appendStatementInput('A').setCheck('CSG');
      this.setInputsInline(true);
      this.setPreviousStatement(true, 'CSG');
      this.setTooltip('Makes a 3D shape hollow with walls this thick. "Open on top" turns a cylinder into a cup.');
    }
  });
  OS.bs_shell = function (block) {
    return wrapStatement(block, 'bs_shell(thickness=' + positive(block, 'THICK', 1) + ', open_top=' + block.getFieldValue('OPEN') + ')');
  };

  Blockly.Blocks.bs_projection = wrapperBlock({
    init: function () {
      this.category = 'BSX_PROJECT';
      this.setColour(modifyColour());
      this.appendDummyInput().appendField('flatten to 2D').appendField(new Blockly.FieldDropdown([
        ['shadow from above', 'false'], ['slice at the floor', 'true']
      ]), 'CUT');
      this.appendStatementInput('A').setCheck('CSG');
      this.setInputsInline(true);
      this.setPreviousStatement(true, 'CAG');
      this.setTooltip('Turns a 3D shape into a flat 2D shape: its shadow seen from above, or the slice where it crosses the floor. Useful for laser cutting.');
    }
  });
  OS.bs_projection = function (block) {
    return wrapStatement(block, 'projection(cut=' + block.getFieldValue('CUT') + ')');
  };

  // Resize and put-on-floor work on 2D and 3D, so they join upstream's TRANSFORM typing and
  // need the same setType that translate has.
  function flexibleType(types, visible) {
    if (!this.workspace) return;
    if (!goog.isArray(types)) types = [types];
    var z = this.getInput('ZVAL');
    var was = this.previousConnection.check_;
    this.previousConnection.setCheck(types);
    this.getInput('A').connection.setCheck(types);
    for (var i = 1; i <= (this.plusCount_ || 0); i++) this.getInput('PLUS' + i).connection.setCheck(types);
    if (!z) return;
    if (types[0] === 'CAG' && was[0] === 'CSG') hideMyInput(z, visible);
    else if (types[0] === 'CSG' && was[0] === 'CAG') showMyInput(z, visible);
  }

  Blockly.Blocks.bs_resize = wrapperBlock({
    init: function () {
      this.category = 'TRANSFORM';
      this.setColour(Blockscad.Toolbox.HEX_TRANSFORM);
      this.appendDummyInput().appendField('resize to');
      numberInput(this, 'XVAL', 'X');
      numberInput(this, 'YVAL', 'Y');
      numberInput(this, 'ZVAL', 'Z');
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([
        ['keep proportions', 'true'], ['stretch', 'false']
      ]), 'AUTO');
      this.appendStatementInput('A').setCheck(['CSG', 'CAG']);
      this.setInputsInline(true);
      this.setPreviousStatement(true, ['CSG', 'CAG']);
      this.setTooltip('Makes a shape an exact size in millimeters. Put 0 on a side to leave it to the others: with "keep proportions" it grows by the same amount.');
    },
    setType: flexibleType
  });
  OS.bs_resize = function (block) {
    var x = num(block, 'XVAL', 0), y = num(block, 'YVAL', 0);
    var z = block.previousConnection.check_[0] === 'CAG' ? 0 : num(block, 'ZVAL', 0);
    return wrapStatement(block, 'resize(newsize=[' + x + ', ' + y + ', ' + z + '], auto=' + block.getFieldValue('AUTO') + ')');
  };

  Blockly.Blocks.bs_on_floor = wrapperBlock({
    init: function () {
      this.category = 'TRANSFORM';
      this.setColour(Blockscad.Toolbox.HEX_TRANSFORM);
      this.appendDummyInput().appendField('sit on the floor, centered');
      this.appendStatementInput('A').setCheck(['CSG', 'CAG']);
      this.setPreviousStatement(true, ['CSG', 'CAG']);
      this.setTooltip('Moves a shape so its bottom rests on the floor (z = 0) and it is centered. 3D printers print from the floor up.');
    },
    setType: flexibleType
  });
  OS.bs_on_floor = function (block) {
    return wrapStatement(block, 'bs_on_floor()');
  };

  // ---- toolbox ----

  function shadow(name, value) {
    return '<value name="' + name + '"><shadow type="math_number"><field name="NUM">' + value + '</field></shadow></value>';
  }
  var EXTRA_2D = '<block type="bs_regular_polygon">' + shadow('SIDES', 6) + shadow('RAD', 10) + '</block>' +
    '<block type="bs_star">' + shadow('POINTS', 5) + shadow('R1', 10) + shadow('R2', 5) + '</block>';
  var MODIFY = '<category name="Modify">' +
    '<block type="bs_round_edges">' + shadow('RAD', 1) + '</block>' +
    '<block type="bs_shell">' + shadow('THICK', 1) + '</block>' +
    '<block type="bs_resize">' + shadow('XVAL', 20) + shadow('YVAL', 0) + shadow('ZVAL', 0) + '</block>' +
    '<block type="bs_on_floor"></block>' +
    '<block type="bs_offset">' + shadow('DIST', 1) + '</block>' +
    '<block type="bs_projection"></block>' +
    '</category>';

  function addToCategory(xml, category, extra) {
    if (!category || xml.indexOf(category) < 0) return xml;
    return xml.replace(category, category.replace(/<\/category>$/, extra + '</category>'));
  }

  function extendToolbox() {
    var T = Blockscad.Toolbox;
    ['adv', 'advExp', 'adv_w_triangles'].forEach(function (name) {
      var xml = T[name];
      if (!xml || xml.indexOf('bs_round_edges') >= 0) return;
      xml = addToCategory(xml, T.cat2D, EXTRA_2D);
      xml = addToCategory(xml, T.cat2DTriangles, EXTRA_2D);
      if (T.catSetOps && xml.indexOf(T.catSetOps) >= 0) xml = xml.replace(T.catSetOps, T.catSetOps + MODIFY);
      T[name] = xml;
    });
  }

  var createToolbox = Blockscad.Toolbox.createToolbox;
  Blockscad.Toolbox.createToolbox = function () {
    var out = createToolbox.apply(this, arguments);
    extendToolbox();
    return out;
  };
  if (Blockscad.Toolbox.adv) extendToolbox();

  // ---- 2D / 3D typing for stacks holding the new blocks ----

  var FIXED_INPUT = { EXTRUDE: 'CAG', COLOR: 'CSG', BSX_2D_OP: 'CAG', BSX_3D_OP: 'CSG', BSX_PROJECT: 'CSG' };
  var MAKES = { PRIMITIVE_CSG: 'CSG', EXTRUDE: 'CSG', COLOR: 'CSG', BSX_3D_OP: 'CSG', PRIMITIVE_CAG: 'CAG', BSX_2D_OP: 'CAG', BSX_PROJECT: 'CAG' };
  var FLEXIBLE = { TRANSFORM: 1, SET_OP: 1, PROCEDURE: 1, LOOP: 1 };
  var NEW_FIXED = { BSX_2D_OP: 1, BSX_3D_OP: 1, BSX_PROJECT: 1 };

  function enclosingFixed(block) {
    for (var p = block.getSurroundParent(); p; p = p.getSurroundParent()) {
      if (FIXED_INPUT[p.category]) return p;
    }
    return null;
  }

  function hasNewFixed(root) {
    return root.getDescendants().some(function (b) { return NEW_FIXED[b.category]; });
  }

  function retypeStack(root) {
    var all = root.getDescendants();
    var top = null;
    all.forEach(function (b) {
      if (!MAKES[b.category] || b.hasDisabledParent && b.hasDisabledParent() || enclosingFixed(b)) return;
      if (MAKES[b.category] === 'CSG') top = 'CSG';
      else if (!top) top = 'CAG';
    });
    all.forEach(function (b) {
      if (!FLEXIBLE[b.category] || !b.setType) return;
      var fixed = enclosingFixed(b);
      var type = fixed ? FIXED_INPUT[fixed.category] : top;
      b.setType(type ? [type] : ['CSG', 'CAG'], !b.collapsedParents());
    });
  }

  // Stacks holding a new block skip upstream's pass entirely. Fixing its result afterwards is too
  // late: it types a translate under "flatten" as 2D (it sees the extrude further up), and
  // Blockly then pulls that translate out of flatten's 3D slot.
  var assignBlockTypes = Blockscad.assignBlockTypes;
  Blockscad.assignBlockTypes = function (blocks) {
    var list = goog.isArray(blocks) ? blocks : [blocks];
    var self = this;
    // Upstream also waits a tick, for the blocks to finish connecting.
    setTimeout(function () {
      var plain = [];
      var done = [];
      list.forEach(function (b) {
        if (!b || !b.workspace) return;
        var root = b.getRootBlock();
        if (!hasNewFixed(root)) plain.push(b);
        else if (done.indexOf(root) < 0) {
          done.push(root);
          retypeStack(root);
        }
      });
      if (plain.length) assignBlockTypes.call(self, plain);
    }, 0);
  };

  // Same rule as upstream (2D and 3D stacks can't render together) with the new categories.
  Blockscad.mixes2and3D = function () {
    var tops = Blockly.mainWorkspace.getTopBlocks();
    var n3 = 0, n2 = 0, nIf = 0, any = 0;
    tops.forEach(function (b) {
      if (!Blockscad.stackIsShape(b)) return;
      any = 1;
      var made = MAKES[b.category];
      if (made === 'CSG') n3++;
      if (made === 'CAG') n2++;
      var input = b.category === 'TRANSFORM' || b.category === 'SET_OP' ? 'A' : (b.category === 'LOOP' ? 'DO' : null);
      if (input && b.getInput(input)) {
        var check = b.getInput(input).connection.check_;
        if (check && check.length === 1) check[0] === 'CSG' ? n3++ : n2++;
      }
      if (b.type === 'controls_if') nIf++;
    });
    if (any && !(n3 + n2 + nIf)) Blockscad.assignBlockTypes(tops);
    return [n3 && n2, any];
  };

  // ---- OpenSCAD export ----
  // The Code tab and "Save OpenSCAD code" should open in real OpenSCAD, so used bs_* modules are
  // written out at the top. Rendering here skips this: the worker has its own versions, and a
  // module defined in the code would hide them.

  var PRELUDE = {
    bs_regular_polygon: 'module bs_regular_polygon(sides=6, r=10) {\n  polygon([for (i = [0:sides-1]) [r*cos(90+360*i/sides), r*sin(90+360*i/sides)]]);\n}',
    bs_star: 'module bs_star(points=5, r1=10, r2=5) {\n  polygon([for (i = [0:2*points-1]) [(i%2==0 ? r1 : r2)*cos(90+180*i/points), (i%2==0 ? r1 : r2)*sin(90+180*i/points)]]);\n}',
    bs_round_edges: '// OpenSCAD has no exact match for "round edges", so here it leaves the shape as it is.\nmodule bs_round_edges(r=1) { children(); }',
    bs_shell: '// OpenSCAD has no exact match for "hollow out", so here it leaves the shape as it is.\nmodule bs_shell(thickness=1, open_top=false) { children(); }',
    bs_on_floor: '// OpenSCAD cannot measure a shape, so "sit on the floor" leaves it where it is.\nmodule bs_on_floor() { children(); }'
  };

  var doRender = Blockscad.doRender;
  Blockscad.doRender = function () {
    Blockscad.renderingNow = true;
    try {
      return doRender.apply(this, arguments);
    } finally {
      Blockscad.renderingNow = false;
    }
  };

  var workspaceToCode = OS.workspaceToCode;
  OS.workspaceToCode = function () {
    var code = workspaceToCode.apply(this, arguments);
    if (Blockscad.renderingNow) return code;
    var used = Object.keys(PRELUDE).filter(function (name) { return code.indexOf(name + '(') >= 0; });
    if (!used.length) return code;
    return '// Extra BlocksCAD blocks, written out so this file also opens in OpenSCAD.\n' +
      used.map(function (n) { return PRELUDE[n]; }).join('\n') + '\n\n' + code;
  };
})();
