name: Log in as demo user
type: http-client-script

const body = {
  grant_type: "password",
  client_id: "web",
  username: bru.getEnvVar("username") || "demo1",
  password: bru.getEnvVar("password") || "DemoPass123!",
};

const res = await bru.sendRequest({
  method: "POST",
  url: `${bru.getEnvVar("keycloak")}/realms/${bru.getEnvVar("realm")}/protocol/openid-connect/token`,
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: { mode: "urlencoded", urlencoded: [body] },
});

const json = JSON.parse(res.body.toString());
bru.setEnvVar("token", json.access_token);
