import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("occupation transitions are Key-owned, cross-Key atomic and release is explicit", async () => {
  const originalChrome = globalThis.chrome;
  const sessionState = Object.create(null);
  let sessionGetFailures = 0;
  globalThis.chrome = {
    storage: {
      session: {
        async setAccessLevel() {},
        async get(key) {
          if (sessionGetFailures > 0) {
            sessionGetFailures -= 1;
            throw new Error("transient session read failure");
          }
          return { [key]: sessionState[key] === undefined ? undefined : structuredClone(sessionState[key]) };
        },
        async set(items) {
          for (const [key, value] of Object.entries(items)) sessionState[key] = structuredClone(value);
        },
      },
    },
  };

  try {
    const moduleUrl = pathToFileURL(
      path.join(workspaceRoot, "out", "extension", "background", "occupation-service.js"),
    );
    const service = await import(`${moduleUrl.href}?test=${Date.now()}`);
    const keyA = "A".repeat(22);
    const keyB = "B".repeat(22);
    const tab1 = tabRef(1, "B");
    const tab2 = tabRef(2, "C");
    const tab3 = tabRef(3, "D");

    const race = await Promise.allSettled([
      service.acquireControl(keyA, { scope: "tab", tabRef: tab1 }),
      service.acquireControl(keyB, { scope: "tab", tabRef: tab1 }),
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(race.filter((result) => result.status === "rejected").length, 1);
    const winner = race[0].status === "fulfilled" ? keyA : keyB;
    const loser = winner === keyA ? keyB : keyA;
    const rejection = race.find((result) => result.status === "rejected");
    assert.equal(rejection.reason?.code, "CONTROL_OCCUPIED");
    assert.deepEqual(rejection.reason?.details, { scope: "tab", tabRef: tab1, ownerKeyId: winner });

    const repeat = await service.acquireControl(winner, { scope: "tab", tabRef: tab1 });
    assert.equal(repeat.alreadyOwned, true);

    let blockedDispatches = 0;
    await assert.rejects(
      service.dispatchWithControlGate(loser, tab1, async () => {
        blockedDispatches += 1;
        return "should-not-run";
      }),
      (error) => error?.code === "CONTROL_OCCUPIED",
    );
    assert.equal(blockedDispatches, 0);

    const foreignRelease = await service.releaseControl({ scope: "tab", tabRef: tab1 });
    assert.deepEqual(foreignRelease, {
      scope: "tab",
      tabRef: tab1,
      released: true,
      previousOwnerKeyId: winner,
    });

    await Promise.all([
      service.acquireControl(keyA, { scope: "tab", tabRef: tab1 }),
      service.acquireControl(keyB, { scope: "tab", tabRef: tab2 }),
    ]);
    await assert.rejects(
      service.acquireControl(keyA, { scope: "global", tabRef: null }),
      (error) => error?.details?.scope === "tab" && error.details.tabRef === tab2,
    );
    await service.releaseControl({ scope: "tab", tabRef: tab2 });
    const global = await service.acquireControl(keyA, { scope: "global", tabRef: null });
    assert.equal(global.alreadyOwned, false);
    await assert.rejects(
      service.acquireControl(keyB, { scope: "tab", tabRef: tab3 }),
      (error) => error?.details?.scope === "global" && error.details.ownerKeyId === keyA,
    );

    let resolveEffect;
    let effectStarted = false;
    const effect = service.dispatchWithControlGate(keyA, tab1, () => {
      effectStarted = true;
      return new Promise((resolve) => {
        resolveEffect = resolve;
      });
    });
    while (!effectStarted) await Promise.resolve();
    const releaseWhileRunning = await Promise.race([
      service.releaseControl({ scope: "global", tabRef: null }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("control lane stayed locked")), 1000)),
    ]);
    assert.equal(releaseWhileRunning.previousOwnerKeyId, keyA);
    resolveEffect("done");
    assert.equal(await effect, "done");

    await service.releaseControl({ scope: "tab", tabRef: tab1 });
    const emptyRelease = await service.releaseControl({ scope: "tab", tabRef: tab1 });
    assert.equal(emptyRelease.released, false);
    assert.equal(emptyRelease.previousOwnerKeyId, null);

    let allowedDispatches = 0;
    assert.equal(
      await service.dispatchWithControlGate(keyB, tab1, async () => {
        allowedDispatches += 1;
        return "allowed";
      }),
      "allowed",
    );
    assert.equal(allowedDispatches, 1);

    await service.acquireControl(keyA, { scope: "tab", tabRef: tab1 });
    const recycledService = await import(`${moduleUrl.href}?recycled=${Date.now()}`);
    const refreshedTab1 = tabRef(1, "Z");
    await assert.rejects(
      recycledService.acquireControl(keyB, { scope: "tab", tabRef: refreshedTab1 }),
      (error) =>
        error?.code === "CONTROL_OCCUPIED" &&
        error.details?.tabRef === tab1 &&
        error.details?.ownerKeyId === keyA,
    );
    const refreshedOwner = await recycledService.acquireControl(keyA, {
      scope: "tab",
      tabRef: refreshedTab1,
    });
    assert.equal(refreshedOwner.alreadyOwned, true);
    await recycledService.releaseControl({ scope: "tab", tabRef: refreshedTab1 });

    sessionGetFailures = 1;
    const retryingService = await import(`${moduleUrl.href}?retry=${Date.now()}`);
    await assert.rejects(retryingService.acquireControl(keyA, { scope: "tab", tabRef: tab1 }));
    const afterRetry = await retryingService.acquireControl(keyA, { scope: "tab", tabRef: tab1 });
    assert.equal(afterRetry.alreadyOwned, false);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

function tabRef(tabId, generationCharacter) {
  return `tr1.${"A".repeat(22)}.${tabId}.${generationCharacter.repeat(22)}`;
}
