'use strict';
// Minimal protobuf wire codec for the few native IM messages (no schema runtime, no dependencies).
const MAX_NESTING = 8;

function varint(value) {
  let n = BigInt(value);
  if (n < 0n) n += 1n << 64n;
  const out = [];
  while (n > 0x7fn) { out.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  out.push(Number(n));
  return Buffer.from(out);
}
const tag = (field, wire) => varint((field << 3) | wire);
const text = value => Buffer.from(String(value ?? ''), 'utf8');

const enc = {
  varint: (field, value) => Buffer.concat([tag(field, 0), varint(value)]),
  bool: (field, value) => enc.varint(field, value ? 1 : 0),
  bytes: (field, value) => { const b = Buffer.from(value); return Buffer.concat([tag(field, 2), varint(b.length), b]); },
  string: (field, value) => enc.bytes(field, text(value)),
  message: (field, parts) => enc.bytes(field, Buffer.concat(parts.filter(Boolean))),
};

// Decode one message level. Varints become Numbers when safe, otherwise BigInt.
function decode(buffer, depth = 0) {
  if (depth > MAX_NESTING) throw new RangeError('protobuf_too_deep');
  const fields = [];
  let pos = 0;
  const readVarint = () => {
    let result = 0n, shift = 0n;
    for (;;) {
      if (pos >= buffer.length || shift > 63n) throw new RangeError('protobuf_truncated');
      const byte = buffer[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  };
  while (pos < buffer.length) {
    const key = Number(readVarint());
    const field = key >>> 3, wire = key & 7;
    if (!field) throw new RangeError('protobuf_bad_field');
    if (wire === 0) {
      const v = readVarint();
      fields.push({field, wire, value: v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v});
    } else if (wire === 2) {
      const len = Number(readVarint());
      if (len < 0 || pos + len > buffer.length) throw new RangeError('protobuf_truncated');
      fields.push({field, wire, value: buffer.subarray(pos, pos + len)});
      pos += len;
    } else if (wire === 1 || wire === 5) {
      const len = wire === 1 ? 8 : 4;
      if (pos + len > buffer.length) throw new RangeError('protobuf_truncated');
      fields.push({field, wire, value: buffer.subarray(pos, pos + len)});
      pos += len;
    } else throw new RangeError('protobuf_unsupported_wire');
  }
  return fields;
}

const first = (fields, field) => fields.find(f => f.field === field)?.value;
const all = (fields, field) => fields.filter(f => f.field === field).map(f => f.value);
const str = (fields, field) => { const v = first(fields, field); return Buffer.isBuffer(v) ? v.toString('utf8') : ''; };
const num = (fields, field) => { const v = first(fields, field); return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0; };
// 64-bit ids: keep them exact as strings.
const id = (fields, field) => { const v = first(fields, field); return typeof v === 'number' || typeof v === 'bigint' ? String(v) : ''; };

module.exports = {varint, enc, decode, first, all, str, num, id, text};
