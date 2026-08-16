import { webEnv } from '../server-env';

/**
 * Server-side Cap.js site verification (ADR 0006). Fails closed: any error,
 * missing key, or non-success reply blocks the login redirect. The token
 * itself is never logged.
 */
export async function verifyCaptcha(token: string): Promise<boolean> {
  const { verifyUrl, siteKey, secretKey } = webEnv().cap;
  if (!token || !siteKey || !secretKey) return false;

  try {
    const res = await fetch(`${verifyUrl.replace(/\/$/, '')}/${siteKey}/siteverify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: secretKey, response: token }),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
