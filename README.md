# BlocksCAD

Visual block-based 3D modeling tool. Drag and drop blocks to create OpenSCAD code, render models in real-time, and export as STL or GLB for 3D printing.

Built on [Blockly](https://developers.google.com/blockly) and [OpenSCAD](https://openscad.org/).

## What this copy adds

The `dist/` bundles are upstream BlocksCAD 1.13 builds, left as they are. No public branch
matches them, so additions live in readable files loaded after the bundles:

- `js/extra-blocks.js`: offset, round edges, hollow out, flatten to 2D, resize, sit on the
  floor, regular polygon and star, plus the toolbox, 2D/3D typing and OpenSCAD export for them.
- `js/extra-modules.js`: turns those blocks' OpenSCAD calls into geometry in the render worker.
  `dist/openscad-openjscad-translator-x1.js` is the upstream translator with one line changed so
  it asks this file about module names it does not know.
- `js/fast-booleans.js`: runs union, difference and intersection through
  [Manifold](https://github.com/elalish/manifold) (`vendor/manifold`, Apache-2.0), falling back
  to csg.js for any shape Manifold refuses.
- `js/render-worker.js`: one render worker kept warm between renders instead of a new one each time.
- `js/pick.js`: click a part of the model to select the block that made it, and the reverse.
