export interface AnkiMarker {
  line: number;
  id?: number;
  deck?: string;
  bulletText: string;
  markerFull: string;
}

export interface GeneratedCard {
  cardType: 'basic' | 'cloze';
  front: string;
  back?: string;
  deck: string;
  correctedBulletText?: string;
}

export interface ProcessedMediaResult {
  content: string;
  mediaToUpload: {
    ankiFileName: string;
    dataBase64: string;
  }[];
}
