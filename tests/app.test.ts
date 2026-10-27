import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("health endpoint", () => {
  it("reports that the HTTP process is healthy", async () => {
    const config = loadConfig({
      TARGET_CIDR: "192.168.1.0/24",
      USE_MOCK_SCANNER: "true",
    });

    const response = await request(createApp(config)).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});

describe("request body parsing", () => {
  it("rejects compressed JSON bodies instead of decompressing them", async () => {
    const config = loadConfig({
      TARGET_CIDR: "192.168.1.0/24",
      USE_MOCK_SCANNER: "true",
    });

    const response = await request(createApp(config))
      .post("/health")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "br")
      .send(Buffer.from([0x0b, 0x01, 0x80]));

    expect(response.status).toBe(415);
  });
});
