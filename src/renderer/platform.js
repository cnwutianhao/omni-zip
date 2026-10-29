// 平台标记：macOS 用隐藏标题栏（hiddenInset），需要给左上角红绿灯留白；
// Windows / Linux 用系统原生标题栏，不需要留白。
//
// 必须独立成文件：index.html 的 CSP 是 default-src 'self'，内联 <script> 会被拦截。
//
// data-platform：二值（mac / other），供 CSS 判断标题栏留白，勿改成三值（styles.css 依赖）。
// data-os：三值（mac / win / linux），供界面文案显示各平台的系统术语。
const ua = navigator.userAgent;
const isMac = ua.includes('Mac');
const isWin = ua.includes('Windows');

document.documentElement.dataset.platform = isMac ? 'mac' : 'other';
document.documentElement.dataset.os = isMac ? 'mac' : isWin ? 'win' : 'linux';
