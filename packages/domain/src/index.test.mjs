import test from "node:test";
import assert from "node:assert/strict";

import { resolveApiBaseUrl, resolveDefaultApiBaseUrl } from "./index.js";

test("ilycode 모바일 정적 호스트는 공개 게이트웨이 API를 사용한다", () => {
  assert.equal(
    resolveDefaultApiBaseUrl({
      origin: "https://octop-mobile.ilycode.app",
      hostname: "octop-mobile.ilycode.app",
      protocol: "https:"
    }),
    "https://octop.ilycode.app"
  );

  assert.equal(
    resolveDefaultApiBaseUrl({
      origin: "https://octop-m.ilycode.app",
      hostname: "octop-m.ilycode.app",
      protocol: "https:"
    }),
    "https://octop.ilycode.app"
  );
});

test("대표 게이트웨이 도메인은 현재 origin을 그대로 유지한다", () => {
  assert.equal(
    resolveDefaultApiBaseUrl({
      origin: "https://octop.ilycode.app",
      hostname: "octop.ilycode.app",
      protocol: "https:"
    }),
    "https://octop.ilycode.app"
  );
});

test("명시 설정값이 있으면 위치 정보보다 우선한다", () => {
  assert.equal(
    resolveApiBaseUrl("https://custom-api.example.com/", {
      origin: "https://octop-mobile.ilycode.app",
      hostname: "octop-mobile.ilycode.app",
      protocol: "https:"
    }),
    "https://custom-api.example.com"
  );
});
