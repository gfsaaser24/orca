// Foreman packaging-smoke wrapper: real config + skip exe editing/signing
// (winCodeSign cache extraction needs symlink privilege this shell lacks).
const base = require('./electron-builder.config.cjs')
module.exports = { ...base, win: { ...base.win, signAndEditExecutable: false } }
