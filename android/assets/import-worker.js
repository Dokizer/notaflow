'use strict';
// Local scripts only: file data never leaves the device during parsing.
importScripts('xlsx.full.min.js','importer.js');
self.onmessage=async function(event){
  const request=event.data||{},id=request.id;
  try{
    const bytes=request.bytes instanceof Uint8Array?request.bytes:new Uint8Array(request.bytes);
    const table=self.NFImporter.parseWorkbook(bytes,{filename:request.filename,sheetIndex:request.sheetIndex,headerRow:request.headerRow});
    self.postMessage({id,ok:true,table});
  }catch(error){self.postMessage({id,ok:false,error:error&&error.message?error.message:'Não foi possível ler a planilha.'});}
};
