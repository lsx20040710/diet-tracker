/**
 * 将图表容器中的 SVG 复制为独立文档，供主进程保存为 SVG 或转换为 PNG。
 * 渲染进程只产生字符串，不接触文件系统和保存路径。
 */
export function serializeChartSvg(container: HTMLElement): string {
  const source = container.querySelector('svg');
  if (!source) {
    throw new Error('当前图表尚未渲染完成，请稍后重试');
  }

  const bounds = source.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('当前图表尺寸无效，请调整窗口后重试');
  }

  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.ceil(bounds.width)));
  clone.setAttribute('height', String(Math.ceil(bounds.height)));
  if (!clone.hasAttribute('viewBox')) {
    clone.setAttribute('viewBox', `0 0 ${Math.ceil(bounds.width)} ${Math.ceil(bounds.height)}`);
  }

  // 图片文件需要明确背景色，否则在深色图片查看器中会出现透明底。
  const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  background.setAttribute('width', '100%');
  background.setAttribute('height', '100%');
  background.setAttribute('fill', '#ffffff');
  clone.insertBefore(background, clone.firstChild);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}`;
}

/** 将 SVG 源码在浏览器内绘制为双倍分辨率 PNG data URL。 */
export async function chartSvgToPngData(svgSource: string): Promise<string> {
  const svgDocument = new DOMParser().parseFromString(svgSource, 'image/svg+xml');
  if (svgDocument.querySelector('parsererror')) {
    throw new Error('无法读取图表尺寸，PNG 导出失败');
  }

  const width = Number(svgDocument.documentElement.getAttribute('width'));
  const height = Number(svgDocument.documentElement.getAttribute('height'));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('图表尺寸无效，PNG 导出失败');
  }

  const imageUrl = URL.createObjectURL(
    new Blob([svgSource], { type: 'image/svg+xml;charset=utf-8' }),
  );
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error('图表转换为 PNG 时加载失败'));
      candidate.src = imageUrl;
    });

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('当前系统无法创建 PNG 图像');
    }

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(imageUrl);
  }
}
