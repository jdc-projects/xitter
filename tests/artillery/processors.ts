import http from 'node:http';

const keycloak = process.env.KEYCLOAK_URL ?? 'http://localhost:8090';
const realm = process.env.XITTER_DEMO_REALM ?? 'xitter-demo';

interface ArtilleryContext {
  vars: Record<string, string>;
}

export function loginDemo(
  context: ArtilleryContext,
  events: { emit: (name: string, err: unknown) => void },
  done: (err?: unknown) => void,
): void {
  token()
    .then((t) => {
      context.vars.token = t;
      done();
    })
    .catch((err) => {
      events.emit('error', err);
      done(err);
    });
}

function token(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: 'web',
    username: process.env.DEMO_USER ?? 'demo1',
    password: process.env.DEMO_PASSWORD ?? 'DemoPass123!',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = http.request(
      `${keycloak}/realms/${realm}/protocol/openid-connect/token`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).access_token ?? '');
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
