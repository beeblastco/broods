/**
 * The one secret-name rule config redaction, MCP header refs and core's log
 * and policy redaction share.
 */

import { describe, expect, it } from "vitest";
import { isSecretName } from "../model/secretNames";

describe("isSecretName", (): void => {
  it("flags names that hold a secret", (): void => {
    for (const name of [
      "Authorization",
      "Proxy-Authorization",
      "Authentication",
      "Auth",
      "x-api-key",
      "X-Auth-Key",
      "X-App-Key",
      "DD-APPLICATION-KEY",
      "apiKey",
      "APIKEY",
      "secretAccessKey",
      "privateKey",
      "Cookie",
      "refreshToken",
      "tokenSecret",
      "oauth_token_secret",
      "TOKEN_SECRET",
      "apiTokens",
      "dbPassword",
      "clientSecret",
      "credentials",
      "kubeconfig",
      "CONVEX_DEPLOY_KEY",
      "PGPASSWORD",
      "clientsecret",
      "accesstoken",
      "APIToken",
      "JWTToken",
      "x-authtoken",
      "secretkey",
      "AWSSECRETKEY",
    ]) {
      expect(isSecretName(name), name).toBe(true);
    }
  });

  it("leaves identifiers, qualifiers and token counts alone", (): void => {
    for (const name of [
      "key",
      "conversationKey",
      "idempotencyKey",
      "publicKey",
      "tokenUrl",
      "authorizationUrl",
      "cookieDomain",
      "inputTokens",
      "inputTokenDetails",
      "maxOutputTokens",
      "noCacheTokens",
      "cacheReadTokens",
      "accessKeyId",
      "credentialAgentId",
      "oauth",
      "monkey",
      "invocations",
    ]) {
      expect(isSecretName(name), name).toBe(false);
    }
  });
});
