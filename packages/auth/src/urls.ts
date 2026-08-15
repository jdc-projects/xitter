/** Standard Keycloak URL helpers shared by apps, services, and scripts. */
export function realmUrls(keycloakBaseUrl: string, realm: string) {
  const base = `${keycloakBaseUrl.replace(/\/$/, "")}/realms/${realm}`;
  return {
    issuer: base,
    jwks: `${base}/protocol/openid-connect/certs`,
    token: `${base}/protocol/openid-connect/token`,
    logout: `${base}/protocol/openid-connect/logout`,
    authorization: `${base}/protocol/openid-connect/auth`,
    admin: `${keycloakBaseUrl.replace(/\/$/, "")}/admin/realms/${realm}`,
  };
}

/** Machine-to-machine client-credentials token endpoint for a realm. */
export function serviceAccountTokenUrl(keycloakBaseUrl: string, realm: string): string {
  return realmUrls(keycloakBaseUrl, realm).token;
}
