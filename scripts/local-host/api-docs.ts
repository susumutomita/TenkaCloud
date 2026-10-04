import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { json } from "./http";
import { localOpenApi } from "./openapi";

const assets = new Map([
  ["/api-docs/swagger-ui-bundle.js", "swagger-ui-bundle.js"],
  ["/api-docs/swagger-ui.css", "swagger-ui.css"],
]);
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TenkaCloud local API</title><link rel="stylesheet" href="/api-docs/swagger-ui.css"></head><body><h1>TenkaCloud local API</h1><p>This listener's role only. Host: POST host/login, then Authorize with idToken. Participant: Authorize with teamLoginKey. Credentials remain in page memory; reload to clear. Create → prepare → poll READY → schedule → participant submit → end → results. Cloud Try It is not supported.</p><div id="swagger-ui"></div><script src="/api-docs/swagger-ui-bundle.js"></script><script src="/api-docs/init.js"></script></body></html>`;
const init = `SwaggerUIBundle({url:'/openapi.json',dom_id:'#swagger-ui',validatorUrl:null,persistAuthorization:false,queryConfigEnabled:false,tryItOutEnabled:false,supportedSubmitMethods:['get','post','patch'],requestSnippetsEnabled:false,requestInterceptor:function(request){const target=new URL(request.url,location.origin);if(target.origin!==location.origin||!target.pathname.startsWith('/api/')&&target.pathname!=='/openapi.json')throw new Error('Only this listener is allowed');return request;}});`;

/** Docs pass the same Host/Origin checks as APIs. Assets never use a CDN or validator. */
export async function serveApiDocs(
  method: string | undefined,
  path: string,
  role: "admin" | "participant",
  response: ServerResponse,
): Promise<boolean> {
  if (method !== "GET") return false;
  if (path === "/openapi.json") {
    json(response, 200, localOpenApi(role));
    return true;
  }
  const asset = assets.get(path);
  if (path !== "/api-docs" && path !== "/api-docs/" && path !== "/api-docs/init.js" && !asset)
    return false;
  let body: string | Buffer = path === "/api-docs/init.js" ? init : html;
  if (asset)
    body = await readFile(
      join(dirname(fileURLToPath(import.meta.resolve("swagger-ui-dist/package.json"))), asset),
    );
  let contentType = "text/html; charset=utf-8";
  if (path.endsWith(".js")) contentType = "application/javascript";
  if (asset?.endsWith(".css")) contentType = "text/css";
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
  return true;
}
