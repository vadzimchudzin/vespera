// Ad-hoc подпись .app перед сборкой DMG. Без неё у бандла подписан только бинарник (подписью линкера),
// ресурсы и Info.plist не запечатаны, и macOS на Apple Silicon отвечает «Не удаётся открыть программу».
// electron-builder 25 не поддерживает identity "-", поэтому подписываем сами.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
