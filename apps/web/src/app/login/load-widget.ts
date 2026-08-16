/**
 * Client-only Cap widget loader. The dynamic import lives here, outside
 * component code - the React Compiler doesn't support import() expressions
 * inside components, and the widget only needs to register its custom
 * element when captcha is actually enabled.
 */
export async function loadCaptchaWidget(): Promise<void> {
  await import('@cap.js/widget');
}
