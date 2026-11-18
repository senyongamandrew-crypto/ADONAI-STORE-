/* A raster of the actual order receipt, not a PDF page or printer command string. */
window.sendThermalReceipt = async function (markup, dots) {
  if (![384, 576].includes(dots)) throw Error('Choose a supported paper width.');
  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-9999px;top:0;width:${dots / 2}px;background:white;pointer-events:none;`;
  host.innerHTML = markup;
  const paper = host.firstElementChild;
  Object.assign(paper.style, {width:'100%', boxSizing:'border-box', padding:'4px', border:'0', boxShadow:'none', overflowWrap:'anywhere'});
  paper.querySelector('table').style.tableLayout = 'fixed';
  paper.querySelector('th').style.width = '40%';
  paper.querySelector('th:nth-child(2)').style.width = '10%';
  document.body.appendChild(host);
  try {
    await Promise.all(Array.from(paper.querySelectorAll('img'), img => img.decode()));
    if (paper.offsetHeight * 2 > 12000) throw Error('This receipt exceeds the supported thermal print length.');
    const canvas = await html2canvas(paper, {scale:2, backgroundColor:'#fff', logging:false});
    const {width, height} = canvas;
    if (width !== dots || !height || height > 12000) throw Error('Receipt does not fit the selected roll.');
    const pixels = canvas.getContext('2d').getImageData(0,0,width,height).data;
    const bytes = new Uint8Array(width * height / 8);
    for (let i=0; i<width*height; i++) {
      const j=i*4;
      if ((pixels[j]*299 + pixels[j+1]*587 + pixels[j+2]*114) < 180000) bytes[i>>3] |= 128 >> (i%8);
    }
    let binary='';
    for (let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    if (!PosAccess.canUse('orders')) throw Error('Unlock Orders before printing.');
    if (!Android.printThermalReceipt(btoa(binary),width,height)) throw Error('Cannot start Bluetooth printing here. Finish any open print job first.');
  } finally { host.remove(); }
};
