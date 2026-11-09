// Remove texture images from a B3DM and rebuild it with geometry only.
//
// The OneMap 3D tiles embed a textured GLB inside each B3DM. This keeps the
// glTF JSON, accessors, Draco geometry and B3DM feature/batch tables intact,
// drops images/textures/samplers and their bufferViews, and repacks the binary
// buffer with 4-byte alignment. Materials are replaced with flat gray.

const B3DM_MAGIC = 0x6d643362; // 'b3dm'
const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const TEXTURE_EXTENSIONS = new Set([
  'KHR_texture_basisu',
  'EXT_texture_webp',
  'EXT_texture_avif',
  'KHR_texture_transform',
]);

function parseGlb(glb) {
  if (glb.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < glb.length) {
    const length = glb.readUInt32LE(offset);
    const type = glb.readUInt32LE(offset + 4);
    const data = glb.subarray(offset + 8, offset + 8 + length);
    if (type === GLB_JSON) json = JSON.parse(data.toString('utf8'));
    else if (type === GLB_BIN) bin = data;
    offset += 8 + length;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

function writeGlb(json, bin) {
  let jsonChunk = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonChunk.length % 4)) % 4;
  if (jsonPad) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(jsonPad, 0x20)]);

  let binChunk = bin ?? Buffer.alloc(0);
  const binPad = (4 - (binChunk.length % 4)) % 4;
  if (binPad) binChunk = Buffer.concat([binChunk, Buffer.alloc(binPad)]);

  const total =
    12 + 8 + jsonChunk.length + (binChunk.length ? 8 + binChunk.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(GLB_JSON, 16);
  jsonChunk.copy(out, 20);

  let offset = 20 + jsonChunk.length;
  if (binChunk.length) {
    out.writeUInt32LE(binChunk.length, offset);
    out.writeUInt32LE(GLB_BIN, offset + 4);
    binChunk.copy(out, offset + 8);
  }
  return out;
}

function stripTextureReferences(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (key.endsWith('Texture')) {
      delete obj[key];
      continue;
    }
    stripTextureReferences(obj[key]);
  }
}

export function stripB3dmTextures(input) {
  if (input.readUInt32LE(0) !== B3DM_MAGIC) throw new Error('not a B3DM');

  const tablesLength =
    input.readUInt32LE(12) +
    input.readUInt32LE(16) +
    input.readUInt32LE(20) +
    input.readUInt32LE(24);
  const tables = input.subarray(28, 28 + tablesLength);
  const { json, bin } = parseGlb(input.subarray(28 + tablesLength));

  const images = json.images ?? [];
  if (!images.length) return input;
  if ((json.buffers?.length ?? 0) !== 1) {
    throw new Error('expected exactly one glTF buffer');
  }

  for (const material of json.materials ?? []) {
    stripTextureReferences(material);
    const pbr =
      material.pbrMetallicRoughness ?? (material.pbrMetallicRoughness = {});
    pbr.baseColorFactor ??= [0.8, 0.8, 0.8, 1];
    pbr.metallicFactor = 0;
    pbr.roughnessFactor = 0.8;
    material.alphaMode = 'OPAQUE';
    delete material.alphaCutoff;
  }

  delete json.images;
  delete json.textures;
  delete json.samplers;
  if (json.extensionsUsed) {
    json.extensionsUsed = json.extensionsUsed.filter(
      (name) => !TEXTURE_EXTENSIONS.has(name),
    );
    if (!json.extensionsUsed.length) delete json.extensionsUsed;
  }
  if (json.extensionsRequired) {
    json.extensionsRequired = json.extensionsRequired.filter(
      (name) => !TEXTURE_EXTENSIONS.has(name),
    );
    if (!json.extensionsRequired.length) delete json.extensionsRequired;
  }
  for (const name of Object.keys(json.extensions ?? {})) {
    if (TEXTURE_EXTENSIONS.has(name)) delete json.extensions[name];
  }

  const imageViews = new Set(
    images.map((image) => image.bufferView).filter((index) => index != null),
  );
  const oldViews = json.bufferViews ?? [];
  const viewMap = new Map();
  const keptViews = [];
  for (let index = 0; index < oldViews.length; index++) {
    if (imageViews.has(index)) continue;
    viewMap.set(index, keptViews.length);
    keptViews.push(oldViews[index]);
  }

  const remapBufferViews = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const value of obj) remapBufferViews(value);
      return;
    }
    if (typeof obj.bufferView === 'number') {
      if (!viewMap.has(obj.bufferView)) {
        throw new Error(`dangling bufferView ${obj.bufferView}`);
      }
      obj.bufferView = viewMap.get(obj.bufferView);
    }
    for (const value of Object.values(obj)) remapBufferViews(value);
  };
  remapBufferViews(json);

  const parts = [];
  let outputLength = 0;
  for (const view of keptViews) {
    const length = view.byteLength ?? 0;
    const start = view.byteOffset ?? 0;
    if (view.buffer !== 0) {
      throw new Error('bufferView points at a non-zero buffer');
    }
    if (!bin || start + length > bin.length) {
      throw new Error('bufferView is outside the BIN chunk');
    }
    const pad = (4 - (outputLength % 4)) % 4;
    if (pad) {
      parts.push(Buffer.alloc(pad));
      outputLength += pad;
    }
    view.byteOffset = outputLength;
    view.buffer = 0;
    parts.push(bin.subarray(start, start + length));
    outputLength += length;
  }

  const newBin = Buffer.concat(parts);
  json.bufferViews = keptViews;
  json.buffers = [{ byteLength: newBin.length }];

  const newGlb = writeGlb(json, newBin);
  const totalLength = 28 + tables.length + newGlb.length;
  const out = Buffer.alloc(totalLength);
  input.copy(out, 0, 0, 28);
  out.writeUInt32LE(totalLength, 8);
  tables.copy(out, 28);
  newGlb.copy(out, 28 + tables.length);
  return out;
}
