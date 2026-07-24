import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function atomicWriteFile(
  path: string,
  contents: string,
  mode?: number,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(temporary, contents, {
    encoding: "utf8",
    ...(mode !== undefined ? { mode } : {}),
  });
  renameSync(temporary, path);
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJsonFile<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
