'use strict';

// Test-only ZIP writer. Metadata overrides intentionally produce hostile archives.
const {deflateRawSync} = require('node:zlib');

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries, options = {}) {
  const locals = [], directory = [];
  let offset = 0;
  for (const [index, entry] of entries.entries()) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.bytes === undefined ? Buffer.from(entry.text || '', 'utf8') : Buffer.from(entry.bytes);
    const method = entry.method === undefined ? 8 : entry.method;
    const packed = method === 0 ? data : deflateRawSync(data);
    const size = entry.declaredSize === undefined ? data.length : entry.declaredSize;
    const crc = entry.declaredCrc === undefined ? crc32(data) : entry.declaredCrc;
    const flags = 0x800 | (entry.encrypted ? 1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size >>> 0, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size >>> 0, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.localOffset === undefined ? options.overlap && index ? 0 : offset : entry.localOffset) >>> 0, 42);
    locals.push(local, name, packed);
    directory.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  const comment = Buffer.from(options.comment || '', 'utf8');
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.diskNumber || 0, 4);
  end.writeUInt16LE(options.centralDisk || 0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...locals, central, end, comment]));
}

function minimalXlsxEntries(rows = [['Cliente', 'NF'], ['Loja', '000123']]) {
  const escape = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[ch]));
  const column = index => {
    let label = '';
    for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) label = String.fromCharCode(65 + (n - 1) % 26) + label;
    return label;
  };
  const sheet = rows.map((row, r) => '<row r="'+(r+1)+'">'+row.map((value, c) => value === null || value === undefined ? '' : typeof value === 'number' ? '<c r="'+column(c)+(r+1)+'"><v>'+value+'</v></c>' : '<c r="'+column(c)+(r+1)+'" t="inlineStr"><is><t>'+escape(value)+'</t></is></c>').join('')+'</row>').join('');
  return [
    {name:'[Content_Types].xml', text:'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'},
    {name:'_rels/.rels', text:'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'},
    {name:'xl/workbook.xml', text:'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Notas" sheetId="1" r:id="rId1"/></sheets></workbook>'},
    {name:'xl/_rels/workbook.xml.rels', text:'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'},
    {name:'xl/worksheets/sheet1.xml', text:'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+sheet+'</sheetData></worksheet>'}
  ];
}

module.exports = {zip, crc32, minimalXlsxEntries};
