import { createWorker, PSM, type Worker } from 'tesseract.js';
import { DrawingItem, SECTIONS, SectionType } from '../types';
import { loadPdfDocument } from './pdfRenderer';

type PdfTextItem = {
  str?: string;
  transform?: number[];
  width?: number;
};

type OcrWord = {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
};

type TitleBlockFields = {
  nameText: string;
  designationText: string;
};

type PdfViewport = {
  width: number;
  height: number;
  convertToViewportPoint: (x: number, y: number) => number[];
};

export interface PdfExtractionProgress {
  page: number;
  totalPages: number;
  message: string;
}

const sectionMatchers: Array<{ section: SectionType; pattern: RegExp }> = [
  { section: 'Токарные+фрезерные работы: Лазер', pattern: /(?:токарные\s*\+\s*фрезерные\s*работы\s*:?\s*)?лазер/iu },
  { section: 'Токарные+фрезерные работы: ВОС', pattern: /(?:токарные\s*\+\s*фрезерные\s*работы\s*:?\s*)?вос(?![а-яё])/iu },
  { section: 'Стандарты', pattern: /стандарт(?:ы|ные изделия)|креп[её]ж/iu },
  { section: 'Токарные+фрезерные работы', pattern: /токарные\s*\+\s*фрезерные\s*работы/iu },
];

function cleanLines(text: string): string[] {
  return text
    .split(/[\r\n]+/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function findSection(text: string): SectionType | null {
  return sectionMatchers.find(({ pattern }) => pattern.test(text))?.section || null;
}

function isRodOrStudSectionTitle(text: string): boolean {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return /прут(?:ки|ок)\s*(?:и\s*)?[\/,&+]?\s*шпильк|мерный\s+сортовой\s+прокат/iu.test(normalized);
}

function findDesignation(lines: string[]): string {
  const patterns = [
    /(?:^|[^A-ZА-ЯЁ0-9])((?:ГОСТ|ОСТ|ТУ|DIN|ISO)\s*[\wА-ЯЁ./-]+)/iu,
    /(?:[A-ZА-ЯЁ0-9]{1,8}\s*\.\s*)?\d{2,}(?:\s*[.-]\s*\d{2,}){2,4}/iu,
  ];

  for (let index = 0; index < lines.length; index++) {
    if (!/^(?:обозначение|номер\s+черт[её]жа)(?=$|[\s:=№-])/iu.test(lines[index])) continue;
    const value = lines[index].replace(/^(?:обозначение|номер\s+черт[её]жа)\s*[:=№-]?\s*/iu, '');
    for (const candidate of [value, lines[index + 1] || '']) {
      for (const pattern of patterns) {
        const match = candidate.match(pattern);
        if (match) return (match[1] || match[0]).replace(/\s+/g, ' ').trim();
      }
    }
  }

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) return (match[1] || match[0]).replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}

function isSectionDivider(text: string, designation: string): boolean {
  if (designation) return false;
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const hasKnownTitle = sectionMatchers.some(({ pattern }) => pattern.test(normalized));
  const isRodTitle = isRodOrStudSectionTitle(normalized);
  return (hasKnownTitle || isRodTitle) && normalized.length < 500;
}

function findName(lines: string[], designation: string): string {
  for (let index = 0; index < lines.length; index++) {
    const label = lines[index].match(/наименовани[ея](?=$|[\s:=])\s*[:=]?\s*(.*)$/iu);
    if (!label) continue;
    const inlineValue = label[1].trim();
    if (inlineValue.length >= 2 && !/^(?:обозначение|материал|масштаб|лист|формат)(?=$|[\s:=])/iu.test(inlineValue)) {
      return inlineValue.slice(0, 100);
    }

    const nextLine = lines[index + 1]?.trim();
    if (nextLine && nextLine.length >= 2 && !/^(?:обозначение|материал|масштаб|лист|формат)(?=$|[\s:=])/iu.test(nextLine)) {
      return nextLine.slice(0, 100);
    }
  }

  const designationIndex = designation
    ? lines.findIndex(line => line.toLowerCase().includes(designation.toLowerCase()))
    : -1;
  const candidates = lines.filter(line => {
    if (line.length < 3 || line.length > 100) return false;
    if (/^(?:наименовани[ея]|обозначение|материал|масштаб|лист|формат|разраб\.|пров\.|утв\.)(?=$|[\s:=])/iu.test(line)) return false;
    if (/^(?:ГОСТ|ОСТ|ТУ|DIN|ISO)\b/iu.test(line)) return false;
    if (/^(?:сталь|материал|масштаб|лист|формат|масса|подп\.|дата)\b/iu.test(line)) return false;
    if (/^[\d\s.,:+/×хx=-]+$/iu.test(line)) return false;
    if (designation && line.toLowerCase().includes(designation.toLowerCase())) return false;
    return /[а-яё]{3,}/iu.test(line);
  });

  if (designationIndex >= 0) {
    const nearby = candidates
      .map(line => ({ line, distance: Math.abs(lines.indexOf(line) - designationIndex) }))
      .filter(candidate => candidate.distance <= 3)
      .sort((left, right) => left.distance - right.distance)[0]?.line;
    if (nearby) return nearby;
  }
  return candidates[0] || '';
}

function isValidTitleBlockName(name: string): boolean {
  return /^[A-ZА-ЯЁ][^\r\n]{1,99}$/u.test(name.trim());
}

function findQuantity(text: string): number | null {
  const labelled = text.match(/(?:кол(?:ичество|\.?\s*[-в]о)?|qty)\s*[:=]?\s*(\d{1,6})/iu);
  if (labelled) return Number(labelled[1]);
  const pieces = text.match(/(?:^|[^а-яё])(\d{1,6})\s*(?:шт\.?|pcs)(?![а-яё])/iu);
  return pieces ? Number(pieces[1]) : null;
}

function findLength(text: string, quantity: number | null, pageNumber: number): string {
  const normalizedLines = cleanLines(text).filter(line =>
    !/масштаб|масса|количеств|кол[\s._-]*во|шт\.?|pcs|гост|ост|ту|лист|раздел|lзаг|заготов/iu.test(line) &&
    !/(?:[A-ZА-ЯЁ0-9]{1,8}\s*\.)?\d{2,}(?:[.-]\d{2,}){2,4}/iu.test(line)
  );
  const dimensionPattern = /(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:мм|mm)(?![\p{L}\p{N}])/iu;

  for (const line of normalizedLines) {
    const explicitLength = line.match(/(?:\bL(?!заг)\s*=?|длин(?:а|у)\s*[:=]?)\s*(\d{1,4}(?:[.,]\d{1,3})?)/iu);
    if (explicitLength) return `${explicitLength[1].replace('.', ',')} мм`;

    const dimension = line.match(dimensionPattern);
    if (dimension) return `${dimension[1].replace('.', ',')} мм`;
  }

  const decimalDimensions = normalizedLines
    .map(line => line.match(/^(?:[<>~]\s*)?(\d{1,4}[.,]\d{1,3})$/u)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(value => ({ value: Number(value.replace(',', '.')), text: value.replace('.', ',') }))
    .filter(candidate => candidate.value >= 2 && candidate.value <= 5000 &&
      candidate.value !== quantity && candidate.value !== pageNumber);
  const uniqueDecimalDimensions = [...new Map(decimalDimensions.map(candidate => [candidate.value, candidate])).values()];
  return uniqueDecimalDimensions.length === 1 ? `${uniqueDecimalDimensions[0].text} мм` : '';
}

function findMaterial(lines: string[]): string {
  const materialPattern = /(?:сталь\s*[А-ЯЁA-Z0-9Хх.-]+|д16т|д16|12х18н10т|09г2с|шх\s*15|бр\s*[А-ЯЁA-Z0-9.-]+)/iu;
  return lines.find(line => materialPattern.test(line))?.match(materialPattern)?.[0] || '';
}

export function parseDrawingPageText(
  rawText: string,
  pageNumber: number,
  section: SectionType,
  titleBlock?: TitleBlockFields
): DrawingItem | null {
  const text = rawText.trim();
  if (!text) return null;

  const lines = cleanLines(text);
  const designationLines = cleanLines(titleBlock?.designationText || '');
  const titleBlockNameLines = cleanLines(titleBlock?.nameText || '');
  const titleBlockDesignation = designationLines.length > 0 ? findDesignation(designationLines) : '';
  const designation = titleBlockDesignation || findDesignation(lines);
  if (isSectionDivider(text, designation)) return null;

  const extractedTitleBlockName = titleBlockNameLines.length > 0
    ? findName(titleBlockNameLines, designation)
    : '';
  const titleBlockName = isValidTitleBlockName(extractedTitleBlockName)
    ? extractedTitleBlockName
    : '';
  const hasPageNameLabel = lines.some(line => /наименовани[ея](?=$|[\s:=])/iu.test(line));
  const pageTextName = designation || hasPageNameLabel ? findName(lines, designation) : '';
  const name = titleBlockName || pageTextName || `Чертеж, лист ${pageNumber}`;
  const quantity = findQuantity(text);
  const partLength = findLength(text, quantity, pageNumber);
  const material = findMaterial(lines);
  const notes = lines
    .filter(line => /чпу|cnc|техн|покрыт|тверд|шероховат|примечан/iu.test(line))
    .slice(0, 5)
    .join('; ');
  const isRodOrStud = /прут|шпильк/iu.test(`${name} ${designation} ${text.slice(0, 1000)}`);
  const isCnc = /\bчпу\b|\bcnc\b/iu.test(text);

  return {
    id: `pdf-${Date.now()}-${pageNumber}`,
    name,
    designation: designation || `Лист ${pageNumber}`,
    quantity,
    code1C: '',
    section,
    material,
    partLength,
    partLengthSource: partLength ? 'drawing' : undefined,
    isCnc,
    pageNumber,
    hasNoStamp: false,
    identificationMark: '',
    notes,
    qtySource: quantity === null ? 'missing' : 'drawing',
    isRodOrStud,
  };
}

function getPageTextItems(items: unknown[]): PdfTextItem[] {
  return items.filter((item): item is PdfTextItem =>
    Boolean(item) && typeof item === 'object' && typeof (item as PdfTextItem).str === 'string'
  );
}

function groupPageText(
  items: PdfTextItem[],
  viewport: PdfViewport,
  bounds?: { left: number; top: number; right: number; bottom: number }
): string {
  const positioned = items
    .filter(item => item.str?.trim() && item.transform?.length === 6)
    .map(item => {
      const transform = item.transform!;
      const baselineLength = Math.hypot(transform[0], transform[1]);
      const textWidth = item.width || 0;
      const endX = baselineLength > 0
        ? transform[4] + (transform[0] / baselineLength) * textWidth
        : transform[4];
      const endY = baselineLength > 0
        ? transform[5] + (transform[1] / baselineLength) * textWidth
        : transform[5];
      const [startX, startY] = viewport.convertToViewportPoint(transform[4], transform[5]);
      const [finishX, finishY] = viewport.convertToViewportPoint(endX, endY);
      return {
        text: item.str!.trim(),
        x: (startX + finishX) / 2,
        y: (startY + finishY) / 2,
      };
    })
    .filter(entry => !bounds || (
      entry.x >= bounds.left &&
      entry.x <= bounds.right &&
      entry.y >= bounds.top &&
      entry.y <= bounds.bottom
    ))
    .sort((left, right) => left.y - right.y || left.x - right.x);

  const rows: Array<{ y: number; entries: Array<{ x: number; text: string }> }> = [];
  for (const entry of positioned) {
    let row = rows.find(candidate => Math.abs(candidate.y - entry.y) < 3);
    if (!row) {
      row = { y: entry.y, entries: [] };
      rows.push(row);
    }
    row.entries.push(entry);
  }

  return rows
    .sort((left, right) => left.y - right.y)
    .map(row => row.entries.sort((left, right) => left.x - right.x).map(entry => entry.text).join(' '))
    .join('\n');
}

function groupOcrTitleBlockWords(
  words: OcrWord[],
  width: number,
  height: number,
  bounds: { left: number; top: number; right: number; bottom: number }
): string {
  const positioned = words
    .filter(word =>
      word.text.trim() &&
      word.bbox.x0 >= width * bounds.left &&
      word.bbox.x1 <= width * bounds.right &&
      word.bbox.y0 >= height * bounds.top &&
      word.bbox.y1 <= height * bounds.bottom
    )
    .map(word => ({ text: word.text.trim(), x: word.bbox.x0, y: word.bbox.y0 }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const rows: Array<{ y: number; entries: Array<{ x: number; text: string }> }> = [];
  for (const entry of positioned) {
    let row = rows.find(candidate => Math.abs(candidate.y - entry.y) < Math.max(3, height * 0.005));
    if (!row) {
      row = { y: entry.y, entries: [] };
      rows.push(row);
    }
    row.entries.push(entry);
  }

  return rows
    .sort((a, b) => a.y - b.y)
    .map(row => row.entries.sort((a, b) => a.x - b.x).map(entry => entry.text).join(' '))
    .join('\n');
}

function cropCanvasToBounds(
  source: HTMLCanvasElement,
  bounds: { left: number; top: number; right: number; bottom: number },
  viewport: { width: number; height: number },
  upscale = 2
): HTMLCanvasElement {
  const x = Math.max(0, Math.floor((bounds.left / viewport.width) * source.width));
  const y = Math.max(0, Math.floor((bounds.top / viewport.height) * source.height));
  const width = Math.max(1, Math.ceil(((bounds.right - bounds.left) / viewport.width) * source.width));
  const height = Math.max(1, Math.ceil(((bounds.bottom - bounds.top) / viewport.height) * source.height));
  const crop = document.createElement('canvas');
  crop.width = width * upscale;
  crop.height = height * upscale;
  const context = crop.getContext('2d');
  if (!context) throw new Error('Браузер не поддерживает обработку штампа на Canvas');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, crop.width, crop.height);
  context.imageSmoothingEnabled = false;
  context.drawImage(source, x, y, width, height, 0, 0, crop.width, crop.height);
  return crop;
}

export async function extractDrawingsFromPdf(
  pdfData: Uint8Array,
  onProgress: (progress: PdfExtractionProgress) => void
): Promise<DrawingItem[]> {
  const pdf = await loadPdfDocument(pdfData);
  const items: DrawingItem[] = [];
  let activeSection: SectionType = SECTIONS[0];
  let activeRodOrStudSection = false;
  let ocrWorker: Worker | null = null;

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      onProgress({ page: pageNumber, totalPages: pdf.numPages, message: `Чтение страницы ${pageNumber} из ${pdf.numPages}` });
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const textItems = getPageTextItems(textContent.items);
      const viewport = page.getViewport({ scale: 1 });
      let text = groupPageText(textItems, viewport);
      const millimetersToPoints = 72 / 25.4;
      const nameBounds = {
        left: Math.max(0, viewport.width - 120 * millimetersToPoints),
        top: Math.max(0, viewport.height - 40 * millimetersToPoints),
        right: viewport.width - 55 * millimetersToPoints,
        bottom: viewport.height - 15 * millimetersToPoints,
      };
      const designationBounds = {
        left: Math.max(0, viewport.width - 100 * millimetersToPoints),
        top: Math.max(0, viewport.height - 58 * millimetersToPoints),
        right: viewport.width - 30 * millimetersToPoints,
        bottom: viewport.height - 40 * millimetersToPoints,
      };
      let titleBlock: TitleBlockFields = {
        nameText: groupPageText(textItems, viewport, nameBounds),
        designationText: groupPageText(textItems, viewport, designationBounds),
      };
      const hasTitleBlockFields = () => (
        isValidTitleBlockName(findName(cleanLines(titleBlock.nameText), '')) &&
        findDesignation(cleanLines(titleBlock.designationText)) !== ''
      );

      if (text.replace(/\s/g, '').length < 70 || !hasTitleBlockFields()) {
        if (!ocrWorker) {
          onProgress({ page: pageNumber, totalPages: pdf.numPages, message: 'Загрузка локальной русской OCR-модели для чтения чертежа и штампа' });
          ocrWorker = await createWorker('rus', 1, {
            workerPath: '/tesseract/worker.min.js',
            corePath: '/tesseract-core',
            langPath: '/tessdata',
            gzip: true,
            cacheMethod: 'write',
            logger: message => {
              if (message.status === 'recognizing text') {
                onProgress({
                  page: pageNumber,
                  totalPages: pdf.numPages,
                  message: `OCR страницы ${pageNumber}: ${Math.round(message.progress * 100)}%`,
                });
              }
            },
          });
        }

        const scale = Math.min(3, 2400 / Math.max(viewport.width, viewport.height));
        const renderViewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(renderViewport.width);
        canvas.height = Math.ceil(renderViewport.height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Браузер не поддерживает обработку PDF на Canvas');
        await page.render({ canvasContext: context, viewport: renderViewport }).promise;
        await ocrWorker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
        const recognized = await ocrWorker.recognize(canvas, {}, { blocks: true });
        text = [text, recognized.data.text].filter(Boolean).join('\n');
        if (!hasTitleBlockFields()) {
          const ocrWords = recognized.data.blocks?.flatMap(block =>
            block.paragraphs.flatMap(paragraph =>
              paragraph.lines.flatMap(line => line.words)
            )
          ) || [];
          const getRatioBounds = (bounds: { left: number; top: number; right: number; bottom: number }) => ({
            left: bounds.left / viewport.width,
            top: bounds.top / viewport.height,
            right: bounds.right / viewport.width,
            bottom: bounds.bottom / viewport.height,
          });
          if (!isValidTitleBlockName(findName(cleanLines(titleBlock.nameText), ''))) {
            titleBlock.nameText = groupOcrTitleBlockWords(
              ocrWords, canvas.width, canvas.height, getRatioBounds(nameBounds)
            );
          }
          if (!findDesignation(cleanLines(titleBlock.designationText))) {
            titleBlock.designationText = groupOcrTitleBlockWords(
              ocrWords, canvas.width, canvas.height, getRatioBounds(designationBounds)
            );
          }
        }

        if (!isValidTitleBlockName(findName(cleanLines(titleBlock.nameText), '')) ||
            !findDesignation(cleanLines(titleBlock.designationText))) {
          await ocrWorker.setParameters({
            tessedit_pageseg_mode: PSM.SINGLE_LINE,
            user_defined_dpi: '300',
          });

          if (!isValidTitleBlockName(findName(cleanLines(titleBlock.nameText), ''))) {
            const nameCrop = cropCanvasToBounds(canvas, nameBounds, viewport);
            const nameResult = await ocrWorker.recognize(nameCrop);
            titleBlock.nameText = nameResult.data.text;
            nameCrop.width = 0;
            nameCrop.height = 0;
          }

          if (!findDesignation(cleanLines(titleBlock.designationText))) {
            const designationCrop = cropCanvasToBounds(canvas, designationBounds, viewport);
            const designationResult = await ocrWorker.recognize(designationCrop);
            titleBlock.designationText = designationResult.data.text;
            designationCrop.width = 0;
            designationCrop.height = 0;
          }
        }
        canvas.width = 0;
        canvas.height = 0;
      }

      const detectedSection = findSection(text);
      const pageItem = parseDrawingPageText(text, pageNumber, activeSection, titleBlock);
      if (!pageItem) {
        if (isRodOrStudSectionTitle(text)) {
          activeRodOrStudSection = true;
        } else if (detectedSection) {
          activeSection = detectedSection;
          activeRodOrStudSection = false;
        }
      } else if (pageItem) {
        if (detectedSection && /титул|раздел/iu.test(text)) {
          activeSection = detectedSection;
          activeRodOrStudSection = false;
        }
        pageItem.section = activeSection;
        pageItem.isRodOrStud = pageItem.isRodOrStud || activeRodOrStudSection;
        items.push(pageItem);
      }
      page.cleanup();
    }
  } finally {
    await ocrWorker?.terminate();
    await pdf.destroy();
  }

  return items;
}