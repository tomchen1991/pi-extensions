import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Hash, validateObservation, type Observation } from "./contract.js";
import { defaultSettings, DestinationSchema, HOUR_MS, HOURLY_REQUEST_LIMIT, MIN_INTERVAL_MS, SettingsSchema, type Destination, type Settings } from "./config.js";
import { digest } from "./identity.js";

const MAX_FILE = 128 * 1024;
const MAX_FILES = 500;
const MAX_BYTES = 50 * 1024 * 1024;
const TIMED_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f0-9]{64}\.json$/;
const LEGACY_NAME = /^[a-f0-9]{64}\.json$/;
export const LatestPointerSchema = z.strictObject({
  schemaVersion: z.literal(1), projectRef: Hash, observationId: Hash,
  observedAt: z.iso.datetime(),
  file: z.string().regex(/^observations\/(?:\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_)?[a-f0-9]{64}\.json$/),
});
export type LatestPointer = z.infer<typeof LatestPointerSchema>;
export function observationFilename(id: string, observedAt: string): string {
  Hash.parse(id); z.iso.datetime().parse(observedAt);
  return `${new Date(observedAt).toISOString().replace(/:/g, "-")}_${id}.json`;
}
function validateFile(file: string, raw: unknown): Observation {
  const observation = validateObservation(raw);
  const name = path.basename(file);
  if (name !== `${observation.observationId}.json` && name !== observationFilename(observation.observationId, observation.source.observedAt)) {
    throw new Error("FILENAME_MISMATCH");
  }
  return observation;
}
function readPointer(file: string): { pointer: LatestPointer; observation: Observation } | undefined {
  const raw = json(file);
  if (raw === undefined) return;
  const pointer = LatestPointerSchema.parse(raw);
  checkDirectory(path.dirname(file));
  checkDirectory(path.join(path.dirname(file), "observations"));
  const target = path.join(path.dirname(file), pointer.file);
  const data = json(target);
  if (data === undefined) throw new Error("LATEST_TARGET_MISSING");
  const observation = validateFile(target, data);
  if (observation.observationId !== pointer.observationId || observation.source.projectRef !== pointer.projectRef ||
    observation.source.observedAt !== pointer.observedAt) throw new Error("LATEST_TARGET_MISMATCH");
  return { pointer, observation };
}
function json(file: string): unknown | undefined {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE || stat.nlink !== 1) throw new Error("UNSAFE_FILE");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
function checkDirectory(dir: string): void {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_DIRECTORY");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
function atomic(file: string, value: unknown): void {
  const data = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(data) > MAX_FILE) throw new Error("FILE_LIMIT");
  const temp = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    json(file); // Fail closed on an unsafe/corrupt existing target.
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export type Reservation = { status: "reserved"; token: string } | { status: "exists" } | { status: "wait"; delay: number };
/** Small file outbox, not a memory database: authorization + rolling request budget + JSON observations. */
export class ObservationStore {
  readonly projectRef: string;
  readonly directory: string;
  readonly outputDirectory: string;
  readonly latestFile: string;
  constructor(readonly base: string, projectRoot: string) {
    if (!path.isAbsolute(base) || !path.isAbsolute(projectRoot)) throw new Error("ABSOLUTE_DIRECTORY_REQUIRED");
    this.projectRef = digest(projectRoot);
    this.directory = path.join(base, "projects", this.projectRef);
    this.outputDirectory = path.join(this.directory, "observations");
    this.latestFile = path.join(this.directory, "latest.json");
  }
  private check(): void {
    for (const dir of [this.base, path.join(this.base, "projects"), this.directory, this.outputDirectory]) checkDirectory(dir);
  }
  settings(): Settings {
    this.check();
    return SettingsSchema.parse(json(path.join(this.directory, "settings.json")) ?? defaultSettings());
  }
  private names(): string[] {
    this.check();
    try { return fs.readdirSync(this.outputDirectory).filter(name => TIMED_NAME.test(name) || LEGACY_NAME.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  /** Resolve by stable ID, including pre-timestamp files. The fallback is the old, absent path. */
  file(id: string): string {
    Hash.parse(id);
    const names = this.names().filter(name => name === `${id}.json` || name.endsWith(`_${id}.json`));
    if (names.length > 1) throw new Error("DUPLICATE_OBSERVATION_FILE");
    return path.join(this.outputDirectory, names[0] ?? `${id}.json`);
  }
  read(id: string): Observation | undefined {
    const file = this.file(id);
    const raw = json(file);
    if (raw === undefined) return;
    const observation = validateFile(file, raw);
    if (observation.observationId !== id || observation.source.projectRef !== this.projectRef) throw new Error("SOURCE_MISMATCH");
    return observation;
  }
  latest(): LatestPointer | undefined {
    this.check();
    const result = readPointer(this.latestFile);
    if (result && result.pointer.projectRef !== this.projectRef) throw new Error("SOURCE_MISMATCH");
    return result?.pointer;
  }
  /** Called under the project lock, after the observation is published. Also repairs interrupted publication. */
  private refreshLatest(): void {
    try {
      const names = this.names();
      // Timestamp names sort chronologically. Legacy hash names need their embedded observedAt.
      const newestName = names.filter(name => TIMED_NAME.test(name)).sort().at(-1);
      const candidates = [...names.filter(name => LEGACY_NAME.test(name)), ...(newestName ? [newestName] : [])];
      let newest: Observation | undefined;
      let file: string | undefined;
      for (const name of candidates) {
        const target = path.join(this.outputDirectory, name);
        const observation = validateFile(target, json(target));
        if (observation.source.projectRef !== this.projectRef) throw new Error("SOURCE_MISMATCH");
        if (!newest || Date.parse(observation.source.observedAt) > Date.parse(newest.source.observedAt) ||
          (Date.parse(observation.source.observedAt) === Date.parse(newest.source.observedAt) && observation.observationId > newest.observationId)) {
          newest = observation; file = `observations/${name}`;
        }
      }
      if (!newest || !file) throw new Error("OBSERVATION_NOT_FOUND");
      const pointer: LatestPointer = { schemaVersion: 1, projectRef: this.projectRef,
        observationId: newest.observationId, observedAt: newest.source.observedAt, file };
      const current = this.latest();
      if (JSON.stringify(current) !== JSON.stringify(pointer)) atomic(this.latestFile, pointer);
    } catch { throw new Error("LATEST_UPDATE_FAILED"); }
  }
  private locked<T>(fn: () => T): T {
    this.check();
    fs.mkdirSync(this.outputDirectory, { recursive: true, mode: 0o700 });
    this.check();
    const lock = path.join(this.directory, ".lock");
    let fd: number;
    try { fd = fs.openSync(lock, "wx", 0o600); } catch { throw new Error("STORE_LOCKED"); }
    try { return fn(); } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  private save(settings: Settings): void { atomic(path.join(this.directory, "settings.json"), SettingsSchema.parse(settings)); }
  authorize(destination: Destination, confirmed: boolean, expectedRevision?: string): void {
    if (!confirmed) throw new Error("CONSENT_REQUIRED");
    this.locked(() => {
      const settings = this.settings();
      // A dialog opened before another instance paused/forgot must not restore its old grant.
      if (expectedRevision !== undefined && settings.revision !== expectedRevision) throw new Error("NOT_AUTHORIZED");
      this.save({ ...settings, destination: DestinationSchema.parse(destination), revision: randomUUID(), enabled: true });
    });
  }
  pause(): void {
    this.locked(() => this.save({ ...this.settings(), enabled: false, revision: randomUUID() }));
  }
  private grant(revision: string, destinationRef?: string): Settings {
    const settings = this.settings();
    if (!settings.enabled || settings.revision !== revision || !settings.destination ||
      (destinationRef !== undefined && settings.destination.fingerprint !== destinationRef)) throw new Error("NOT_AUTHORIZED");
    return settings;
  }
  reserve(id: string, revision: string, destinationRef: string, now = Date.now()): Reservation {
    Hash.parse(id);
    return this.locked(() => {
      const settings = this.grant(revision, destinationRef);
      if (this.read(id)) { this.refreshLatest(); return { status: "exists" }; }
      settings.attempts = settings.attempts.filter(a => a.at + HOUR_MS > now);
      const latest = Math.max(-Infinity, ...settings.attempts.map(a => a.at));
      const oldest = Math.min(Infinity, ...settings.attempts.map(a => a.at));
      const next = Math.max(latest + MIN_INTERVAL_MS, settings.attempts.length >= HOURLY_REQUEST_LIMIT ? oldest + HOUR_MS : 0);
      if (next > now) return { status: "wait", delay: next - now };
      // Failed/cancelled calls also consume the budget. Persist before requesting the model.
      this.capacity();
      const token = randomUUID();
      settings.attempts.push({ at: now, observationId: id, token });
      this.save(settings);
      return { status: "reserved", token };
    });
  }
  publish(raw: Observation, revision: string, token: string): "published" | "exists" {
    const observation = validateObservation(raw);
    return this.locked(() => {
      const settings = this.grant(revision, observation.extraction.destinationRef);
      const attempt = settings.attempts.find(a => a.observationId === observation.observationId && a.token === token);
      if (!attempt || observation.source.projectRef !== this.projectRef ||
        settings.destination!.provider !== observation.extraction.provider || settings.destination!.model !== observation.extraction.model) {
        throw new Error("INVALID_RESERVATION");
      }
      if (this.read(observation.observationId)) { this.refreshLatest(); return "exists"; }
      this.capacity(Buffer.byteLength(JSON.stringify(observation, null, 2)) + 1);
      atomic(path.join(this.outputDirectory, observationFilename(observation.observationId, observation.source.observedAt)), observation);
      this.refreshLatest();
      return "published";
    });
  }
  private capacity(extra = 0): void {
    const files = fs.readdirSync(this.outputDirectory);
    let bytes = 0;
    for (const name of files) {
      const stat = fs.lstatSync(path.join(this.outputDirectory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("UNSAFE_FILE");
      bytes += stat.size;
    }
    if (files.length >= MAX_FILES || bytes + extra > MAX_BYTES) throw new Error("STORAGE_LIMIT");
  }
  forget(): void {
    this.locked(() => {
      // Revoke first; another process's in-flight result cannot recreate the output.
      this.save({ ...this.settings(), enabled: false, revision: randomUUID() });
      // Remove the pointer before its targets, so normal clearing never leaves a dangling latest.json.
      try { fs.unlinkSync(this.latestFile); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const name of fs.readdirSync(this.outputDirectory)) {
        if (TIMED_NAME.test(name) || LEGACY_NAME.test(name) || /^\.[a-f0-9-]+\.tmp$/.test(name)) fs.unlinkSync(path.join(this.outputDirectory, name));
      }
    });
  }
}

export function inspect(file: string): Observation {
  if (path.basename(file) === "latest.json") {
    const latest = readPointer(file);
    if (!latest) throw new Error("OBSERVATION_NOT_FOUND");
    return latest.observation;
  }
  const value = json(file);
  if (value === undefined) throw new Error("OBSERVATION_NOT_FOUND");
  return validateObservation(value);
}
