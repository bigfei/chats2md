import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";

const ROOT = process.cwd();
const RELEASE_DIR = path.join(ROOT, "release");
const REQUIRED_FILES = ["main.js", "manifest.json", "styles.css"];

async function assertExists(filePath) {
  try {
    await stat(filePath);
  } catch {
    throw new Error(`Missing required file: ${path.basename(filePath)}. Run "npm run build" first.`);
  }
}

async function main() {
  const manifestPath = path.join(ROOT, "manifest.json");
  await assertExists(manifestPath);

  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);

  const pluginId = manifest.id?.trim();
  const version = manifest.version?.trim();
  if (!pluginId || !version) {
    throw new Error("manifest.json must include non-empty id and version fields.");
  }

  const zip = new JSZip();
  const prefix = `${pluginId}/`;

  for (const fileName of REQUIRED_FILES) {
    const absolutePath = path.join(ROOT, fileName);
    await assertExists(absolutePath);
    const content = await readFile(absolutePath);
    zip.file(`${prefix}${fileName}`, content);
  }

  await mkdir(RELEASE_DIR, { recursive: true });
  const outputName = `${pluginId}-${version}.zip`;
  const outputPath = path.join(RELEASE_DIR, outputName);
  const zipBytes = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });

  await writeFile(outputPath, zipBytes);
  console.log(`Created ${path.relative(ROOT, outputPath)}`);
}

await main();
