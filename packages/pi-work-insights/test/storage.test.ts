import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObservationStore, inspect, observationFilename } from "../src/storage.js";
import { observationId, type Observation } from "../src/contract.js";
import { destinationFor, HOUR_MS, MIN_INTERVAL_MS } from "../src/config.js";
import { digest } from "../src/identity.js";
import { destination, fixture, model } from "./fixtures/synthetic.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-observation-store-")); dirs.push(dir);
  return new ObservationStore(path.join(dir, "output"), "/synthetic/project");
}
function granted() {
  const store = setup(); store.authorize(destination, true);
  return { store, revision: store.settings().revision, observation: fixture() };
}
function reserved() {
  const values = granted();
  const r = values.store.reserve(values.observation.observationId, values.revision, destination.fingerprint);
  if (r.status !== "reserved") throw Error("expected reservation");
  return { ...values, token: r.token };
}

describe("authorization and request budget", () => {
  it("reading disabled state never creates directories or reads conversation content", () => {
    const store = setup();
    expect(store.settings()).toMatchObject({ enabled: false, destination: null, attempts: [] });
    expect(fs.existsSync(store.directory)).toBe(false);
    expect(store.latest()).toBeUndefined();
    expect(() => store.authorize(destination, false)).toThrow("CONSENT_REQUIRED");
    expect(fs.existsSync(store.directory)).toBe(false);
  });
  it("pins exact provider/model/configuration while keeping credentials out of persisted settings", () => {
    const store = setup();
    const secretModel = { ...model, baseUrl: "https://user:password@fixture.invalid/v1?token=private" };
    const grant = destinationFor(secretModel, { headers: { Authorization: "secret-value" } });
    store.authorize(grant, true);
    const raw = fs.readFileSync(path.join(store.directory, "settings.json"), "utf8");
    expect(raw).not.toMatch(/password|private|secret-value/);
    expect(grant.fingerprint).not.toBe(destinationFor(secretModel, { headers: {} }).fingerprint);
    expect(() => store.reserve(digest("a"), store.settings().revision, destination.fingerprint)).toThrow("NOT_AUTHORIZED");
  });
  it("automatic initialization pins the first model once and preserves budget across other instances", () => {
    const store = setup();
    const first = store.initializeAutomatic(destination);
    expect(first).toMatchObject({ enabled: true, destination, attempts: [] });
    const reservation = store.reserve(digest("a"), first.revision, destination.fingerprint);
    expect(reservation.status).toBe("reserved");
    const again = new ObservationStore(store.base, "/synthetic/project");
    const other = destinationFor({ ...model, id: "other-model" }, null);
    expect(again.initializeAutomatic(other)).toEqual(store.settings());
    expect(again.settings()).toMatchObject({ revision: first.revision, destination });
    expect(again.settings().attempts).toHaveLength(1);
  });
  it.each(["pause", "forget"])("automatic initialization never overrides %s before or after the first grant", action => {
    const store = setup();
    if (action === "pause") store.pause(); else store.forget();
    const disabled = store.settings();
    expect(store.initializeAutomatic(destination)).toEqual(disabled);
    store.authorize(destination, true);
    if (action === "pause") store.pause(); else store.forget();
    const stopped = store.settings();
    expect(store.initializeAutomatic(destination)).toEqual(stopped);
    expect(store.settings().enabled).toBe(false);
  });
  it("counts cancelled/failed requests, enforces interval, and persists budget across instances", () => {
    const { store, revision } = granted(); const now = 1_000_000;
    expect(store.reserve(digest("a"), revision, destination.fingerprint, now).status).toBe("reserved");
    const again = new ObservationStore(store.base, "/synthetic/project");
    expect(again.reserve(digest("b"), revision, destination.fingerprint, now + 1)).toEqual({ status: "wait", delay: MIN_INTERVAL_MS - 1 });
    expect(again.settings().attempts).toHaveLength(1);
  });
  it("enforces a rolling six-request hourly limit, retained through reauthorization", () => {
    const { store } = granted(); const now = 1_000_000;
    for (let i = 0; i < 6; i++) {
      expect(store.reserve(digest(i), store.settings().revision, destination.fingerprint, now + i * MIN_INTERVAL_MS).status).toBe("reserved");
    }
    store.authorize(destination, true);
    expect(store.reserve(digest(6), store.settings().revision, destination.fingerprint, now + 6 * MIN_INTERVAL_MS)).toEqual({ status: "wait", delay: HOUR_MS - 6 * MIN_INTERVAL_MS });
    expect(store.reserve(digest(6), store.settings().revision, destination.fingerprint, now + HOUR_MS).status).toBe("reserved");
    expect(store.settings().attempts).toHaveLength(6);
  });
  it("does not bypass limits when the wall clock moves backwards", () => {
    const { store, revision } = granted();
    store.reserve(digest("a"), revision, destination.fingerprint, 1_000_000);
    expect(store.reserve(digest("b"), revision, destination.fingerprint, 900_000).status).toBe("wait");
  });
});

describe("observation JSON outbox", () => {
  it("writes validated JSON with private permissions and no duplicate calls after reload", () => {
    const { store, revision, observation, token } = reserved();
    expect(store.publish(observation, revision, token)).toBe("published");
    expect(inspect(store.file(observation.observationId))).toEqual(observation);
    expect(fs.statSync(store.file(observation.observationId)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(store.outputDirectory).mode & 0o777).toBe(0o700);
    expect(store.publish(observation, revision, token)).toBe("exists");
    expect(store.reserve(observation.observationId, revision, destination.fingerprint).status).toBe("exists");
    expect(store.settings().attempts).toHaveLength(1);
  });
  it("does not overwrite a successful output with a later nondeterministic response", () => {
    const { store, revision, observation, token } = reserved(); store.publish(observation, revision, token);
    expect(store.publish({ ...observation, source: { ...observation.source, observedAt: "2026-02-01T00:00:00.000Z" } }, revision, token)).toBe("exists");
    expect(store.read(observation.observationId)).toEqual(observation);
  });
  it("requires a matching reservation and project", () => {
    const { store, revision, observation } = granted();
    expect(() => store.publish(observation, revision, "fake")).toThrow("INVALID_RESERVATION");
    expect(() => store.file("../escape")).toThrow();
    expect(new ObservationStore(store.base, "/other/project").projectRef).not.toBe(store.projectRef);
  });
  it("pause invalidates another instance's pending result", () => {
    const { store, revision, observation, token } = reserved();
    new ObservationStore(store.base, "/synthetic/project").pause();
    expect(() => store.publish(observation, revision, token)).toThrow("NOT_AUTHORIZED");
    expect(store.read(observation.observationId)).toBeUndefined();
  });
  it("forget deletes this project's output and revokes stale results even after re-enabling", () => {
    const { store, revision, observation, token } = reserved(); store.publish(observation, revision, token);
    const other = new ObservationStore(store.base, "/other/project"); other.authorize(destination, true);
    store.forget();
    expect(store.settings().enabled).toBe(false);
    expect(fs.readdirSync(store.outputDirectory)).toEqual([]);
    expect(fs.existsSync(store.latestFile)).toBe(false);
    expect(store.latest()).toBeUndefined();
    expect(other.settings().enabled).toBe(true);
    store.authorize(destination, true);
    expect(() => store.publish(observation, revision, token)).toThrow("NOT_AUTHORIZED");
    expect(store.settings().attempts).toHaveLength(1);
  });
  it("rejects corrupt and incompatible JSON instead of treating it as an empty observation", () => {
    const { store, revision, observation } = granted();
    fs.writeFileSync(store.file(observation.observationId), "{bad");
    expect(() => store.reserve(observation.observationId, revision, destination.fingerprint)).toThrow();
    expect(() => inspect(store.file(observation.observationId))).toThrow();
    fs.writeFileSync(path.join(store.directory, "settings.json"), JSON.stringify({ ...store.settings(), version: 99 }));
    expect(() => store.settings()).toThrow();
  });
  it("rejects symlinked directories and files", () => {
    const store = setup(); fs.mkdirSync(path.dirname(store.base), { recursive: true });
    const target = path.join(path.dirname(store.base), "target"); fs.mkdirSync(target);
    fs.symlinkSync(target, store.base);
    expect(() => store.settings()).toThrow("UNSAFE_DIRECTORY");
    const { store: safe } = granted();
    const external = path.join(target, "external.json"); fs.writeFileSync(external, "{}");
    fs.symlinkSync(external, safe.file(digest("symlink")));
    expect(() => safe.read(digest("symlink"))).toThrow();
  });
  it("fails closed on an oversized file and a full outbox", () => {
    const { store, revision } = granted();
    const file = store.file(digest("big")); fs.writeFileSync(file, "x".repeat(128 * 1024 + 1));
    expect(() => store.read(digest("big"))).toThrow("UNSAFE_FILE");
    fs.unlinkSync(file);
    for (let i = 0; i < 500; i++) fs.writeFileSync(store.file(digest(i)), "{}");
    expect(() => store.reserve(digest("new"), revision, destination.fingerprint)).toThrow("STORAGE_LIMIT");
  });
  it("does not steal a live or crash-left lock", () => {
    const { store } = granted();
    fs.writeFileSync(path.join(store.directory, ".lock"), "");
    expect(() => store.pause()).toThrow("STORE_LOCKED");
    expect(store.settings().enabled).toBe(true);
  });
});

function timed(time: string, seed: string, empty = false): Observation {
  const value = fixture(empty);
  value.source.observedAt = time;
  value.source.inputDigest = digest(seed);
  value.observationId = observationId(value);
  return value;
}
function reserveOutput(store: ObservationStore, observation: Observation, now: number): string {
  const result = store.reserve(observation.observationId, store.settings().revision, destination.fingerprint, now);
  if (result.status !== "reserved") throw Error(`Expected reservation: ${result.status}`);
  return result.token;
}

describe("timestamped files and project latest pointer", () => {
  it("names files with canonical UTC milliseconds and writes a small relative pointer", () => {
    const { store, revision, observation, token } = reserved();
    store.publish(observation, revision, token);
    const name = `2026-01-01T00-00-00.000Z_${observation.observationId}.json`;
    expect(fs.readdirSync(store.outputDirectory)).toEqual([name]);
    expect(store.file(observation.observationId)).toBe(path.join(store.outputDirectory, name));
    expect(store.latest()).toEqual({ schemaVersion: 1, projectRef: store.projectRef,
      observationId: observation.observationId, observedAt: observation.source.observedAt, file: `observations/${name}` });
    expect(inspect(store.latestFile)).toEqual(observation);
    expect(fs.statSync(store.latestFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(store.latestFile, "utf8")).not.toContain("recentWork");
    expect(observationFilename(observation.observationId, "2026-01-01T00:00:00Z")).toBe(name);
  });
  it("never replaces newer observedAt with an older request that finishes later, even from another instance", () => {
    const { store, revision } = granted();
    const older = timed("2026-01-01T00:00:00.000Z", "older");
    const newer = timed("2026-01-01T00:01:00.000Z", "newer");
    const oldToken = reserveOutput(store, older, 1_000_000);
    const newToken = reserveOutput(store, newer, 1_000_000 + MIN_INTERVAL_MS);
    store.publish(newer, revision, newToken);
    const another = new ObservationStore(store.base, "/synthetic/project");
    another.publish(older, revision, oldToken);
    expect(another.latest()?.observationId).toBe(newer.observationId);
    expect(fs.readdirSync(store.outputDirectory).sort()).toEqual([
      observationFilename(older.observationId, older.source.observedAt), observationFilename(newer.observationId, newer.source.observedAt),
    ]);
    // Filesystem mtime is not observation time.
    fs.utimesSync(store.file(older.observationId), new Date("2030-01-01"), new Date("2030-01-01"));
    another.reserve(older.observationId, revision, destination.fingerprint);
    expect(inspect(store.latestFile)).toEqual(newer);
  });
  it("uses a stable ID tie-break for equal timestamps, independent of publication order", () => {
    const values = [timed("2026-01-01T00:00:00.000Z", "a"), timed("2026-01-01T00:00:00.000Z", "b")];
    for (const order of [values, values.slice().reverse()]) {
      const { store, revision } = granted();
      const tokens = order.map((o, i) => reserveOutput(store, o, 1_000_000 + i * MIN_INTERVAL_MS));
      order.forEach((o, i) => store.publish(o, revision, tokens[i]));
      expect(store.latest()?.observationId).toBe(values.map(o => o.observationId).sort().at(-1));
    }
  });
  it("deduplicates by ID without changing the original timestamp or promoting an old window", () => {
    const { store, revision, observation, token } = reserved();
    store.publish(observation, revision, token);
    const before = fs.readFileSync(store.latestFile, "utf8");
    const file = store.file(observation.observationId);
    const retried = structuredClone(observation); retried.source.observedAt = "2026-02-01T00:00:00.000Z";
    expect(store.publish(retried, revision, token)).toBe("exists");
    expect(store.file(observation.observationId)).toBe(file);
    expect(fs.readFileSync(store.latestFile, "utf8")).toBe(before);
    expect(fs.readdirSync(store.outputDirectory)).toHaveLength(1);
  });
  it("keeps a valid empty observation as latest rather than silently returning older content", () => {
    const { store, revision } = granted();
    const full = timed("2026-01-01T00:00:00.000Z", "full");
    store.publish(full, revision, reserveOutput(store, full, 1_000_000));
    const empty = timed("2026-01-02T00:00:00.000Z", "empty", true);
    store.publish(empty, revision, reserveOutput(store, empty, 1_000_000 + MIN_INTERVAL_MS));
    expect(inspect(store.latestFile)).toEqual(empty);
    expect(store.read(full.observationId)).toEqual(full);
  });
  it("recognizes legacy hash-only files and builds latest without spending another request", () => {
    const { store, revision, observation } = granted();
    const legacy = store.file(observation.observationId);
    fs.writeFileSync(legacy, JSON.stringify(observation), { mode: 0o600 });
    expect(store.reserve(observation.observationId, revision, destination.fingerprint).status).toBe("exists");
    expect(store.settings().attempts).toHaveLength(0);
    expect(store.latest()?.file).toBe(`observations/${observation.observationId}.json`);
    expect(store.file(observation.observationId)).toBe(legacy);
    const older = timed("2025-12-31T00:00:00.000Z", "older");
    store.publish(older, revision, reserveOutput(store, older, 1_000_000));
    expect(inspect(store.latestFile)).toEqual(observation);
    store.forget();
    expect(fs.readdirSync(store.outputDirectory)).toEqual([]);
    expect(store.latest()).toBeUndefined();
  });
  it("does not update latest when the observation write fails", () => {
    const { store, revision, observation, token } = reserved(); store.publish(observation, revision, token);
    const next = timed("2026-02-01T00:00:00.000Z", "next");
    const nextToken = reserveOutput(store, next, Date.now() + MIN_INTERVAL_MS);
    const realRename = fs.renameSync;
    const target = path.join(store.outputDirectory, observationFilename(next.observationId, next.source.observedAt));
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === target) throw Error("synthetic disk failure");
      realRename(from, to);
    });
    expect(() => store.publish(next, revision, nextToken)).toThrow("disk failure");
    expect(store.latest()?.observationId).toBe(observation.observationId);
    expect(store.read(next.observationId)).toBeUndefined();
  });
  it("repairs a pointer-update failure from saved JSON without another request, even on an older ID lookup", () => {
    const { store, revision, observation, token } = reserved(); store.publish(observation, revision, token);
    const next = timed("2026-02-01T00:00:00.000Z", "next");
    const nextToken = reserveOutput(store, next, Date.now() + MIN_INTERVAL_MS);
    const realRename = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === store.latestFile) throw Error("synthetic index failure");
      realRename(from, to);
    });
    expect(() => store.publish(next, revision, nextToken)).toThrow("LATEST_UPDATE_FAILED");
    expect(store.read(next.observationId)).toEqual(next);
    expect(store.latest()?.observationId).toBe(observation.observationId);
    spy.mockRestore();
    expect(store.reserve(observation.observationId, revision, destination.fingerprint).status).toBe("exists");
    expect(store.latest()?.observationId).toBe(next.observationId);
    expect(store.settings().attempts).toHaveLength(2);
  });
  it("rebuilds a missing pointer from the newest saved file, not the most recently requested old ID", () => {
    const { store, revision, observation, token } = reserved(); store.publish(observation, revision, token);
    const next = timed("2026-02-01T00:00:00.000Z", "next");
    store.publish(next, revision, reserveOutput(store, next, Date.now() + MIN_INTERVAL_MS));
    fs.unlinkSync(store.latestFile);
    store.reserve(observation.observationId, revision, destination.fingerprint);
    expect(store.latest()?.observationId).toBe(next.observationId);
  });
  it("rejects unsafe/mismatched pointers and missing targets rather than guessing an old file", () => {
    const { store, revision, observation, token } = reserved(); store.publish(observation, revision, token);
    const pointer = store.latest()!;
    for (const patch of [{ file: "../outside.json" }, { projectRef: digest("other") }, { observedAt: "2020-01-01T00:00:00.000Z" }]) {
      fs.writeFileSync(store.latestFile, JSON.stringify({ ...pointer, ...patch }));
      expect(() => store.latest()).toThrow();
      expect(() => inspect(store.latestFile)).toThrow();
    }
    fs.writeFileSync(store.latestFile, JSON.stringify(pointer));
    fs.unlinkSync(store.file(observation.observationId));
    expect(() => store.latest()).toThrow("LATEST_TARGET_MISSING");
  });
  it("rejects symlinked latest pointers and symlinked pointer targets", () => {
    const { store, revision, observation, token } = reserved(); store.publish(observation, revision, token);
    const pointerCopy = path.join(store.directory, "pointer-copy.json");
    fs.renameSync(store.latestFile, pointerCopy);
    fs.symlinkSync(pointerCopy, store.latestFile);
    expect(() => store.latest()).toThrow();
    fs.unlinkSync(store.latestFile); fs.renameSync(pointerCopy, store.latestFile);
    const target = store.file(observation.observationId);
    const copy = path.join(store.directory, "observation-copy.json");
    fs.renameSync(target, copy); fs.symlinkSync(copy, target);
    expect(() => inspect(store.latestFile)).toThrow();
  });
  it("validates timestamped filenames against their contents and detects duplicate ID files", () => {
    const { store, revision, observation, token } = reserved(); store.publish(observation, revision, token);
    const actual = store.file(observation.observationId);
    const wrong = path.join(store.outputDirectory, observationFilename(observation.observationId, "2020-01-01T00:00:00.000Z"));
    fs.renameSync(actual, wrong);
    expect(() => store.read(observation.observationId)).toThrow("FILENAME_MISMATCH");
    fs.copyFileSync(wrong, actual);
    expect(() => store.read(observation.observationId)).toThrow("DUPLICATE_OBSERVATION_FILE");
  });
});
