// Local Windows build wrapper: real config + modern winCodeSign toolset.
// The legacy default toolset is a single 7z containing darwin symlinks, whose
// extraction needs a symlink privilege normal Windows users lack; toolset
// 1.1.0 downloads per-platform ZIPs (no symlinks) and builds unprivileged.
// Upstream config stays untouched for CI parity.
const base = require('./electron-builder.config.cjs')
module.exports = { ...base, toolsets: { winCodeSign: '1.1.0' } }
