import assert from "node:assert/strict";
import test from "node:test";
import { verifyVersionBump } from "./check-version.ts";

test("app changes cannot be released with an unchanged or lower version", () => {
  assert.throws(() => verifyVersionBump("1.0.0", "1.0.0", ["speech/server.ts"]), /提升版本号/);
  assert.throws(() => verifyVersionBump("1.2.0", "1.1.9", ["speech/app.ts"]), /提升版本号/);
  assert.throws(() => verifyVersionBump("1.0.0", "1.0.0", ["install.command"]), /提升版本号/);
});
test("patch, minor and major releases compare numeric components", () => {
  for (const [before, after] of [["1.0.9", "1.0.10"], ["1.0.10", "1.1.0"], ["1.9.9", "2.0.0"]]) {
    assert.doesNotThrow(() => verifyVersionBump(before, after, ["speech/server.ts"]));
  }
});
test("first versioned release can upgrade an unversioned installation", () => {
  assert.doesNotThrow(() => verifyVersionBump(undefined, "1.0.0", ["package.json", "speech/app.ts"]));
});
test("documentation and tests alone can keep a version but cannot downgrade it", () => {
  assert.doesNotThrow(() => verifyVersionBump("1.0.0", "1.0.0", ["README.md", "speech/server.test.ts"]));
  assert.throws(() => verifyVersionBump("1.1.0", "1.0.0", ["package.json"]), /提升版本号/);
});
test("malformed release versions fail instead of silently bypassing the gate", () => {
  for (const version of [undefined, "1.0", "1.00.0", "1.0.0-beta", "banana"]) {
    assert.throws(() => verifyVersionBump("1.0.0", version, ["speech/server.ts"]), /版本号/);
  }
});
