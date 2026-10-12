import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=table[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
export async function zipDirectory(directory,output){
  const names=[];
  async function walk(relative=''){for(const entry of await readdir(join(directory,relative),{withFileTypes:true})){const name=relative?relative+'/'+entry.name:entry.name;if(entry.isDirectory())await walk(name);else if(entry.isFile())names.push(name);}}
  await walk();names.sort();
  const locals=[],centrals=[];let offset=0;
  for(const name of names){
    const bytes=await readFile(join(directory,name));const compressed=deflateRawSync(bytes);const filename=Buffer.from(name);const crc=crc32(bytes);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(filename.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(8,10);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);
    locals.push(local,filename,compressed);centrals.push(central,filename);offset+=local.length+filename.length+compressed.length;
  }
  const centralData=Buffer.concat(centrals);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(names.length,8);end.writeUInt16LE(names.length,10);end.writeUInt32LE(centralData.length,12);end.writeUInt32LE(offset,16);
  await writeFile(output,Buffer.concat([...locals,centralData,end]));
}
