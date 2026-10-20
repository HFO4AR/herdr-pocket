// Small real PNG generator for browser preview tests: no binary fixture in the repo.
const zlib=require('node:zlib');
const TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return t;})();
function crc32(buf){let c=0xffffffff;for(const b of buf)c=TABLE[(c^b)&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(type,data){const head=Buffer.alloc(8);head.writeUInt32BE(data.length,0);head.write(type,4,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4),data])),0);return Buffer.concat([head,data,crc]);}
/** A real RGB PNG made only with zlib + struct-like writes. */
function png(width=2400,height=3200,rgb=[64,116,158]){
 const raw=Buffer.alloc((width*3+1)*height);
 for(let y=0;y<height;y++){
  const at=y*(width*3+1);raw[at]=0;
  const shade=y%64<32?1:0.86;
  for(let x=0;x<width;x++){const p=at+1+x*3;raw[p]=Math.round(rgb[0]*shade);raw[p+1]=Math.round(rgb[1]*shade);raw[p+2]=Math.round(rgb[2]*shade);}
 }
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
 return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
module.exports={png};
