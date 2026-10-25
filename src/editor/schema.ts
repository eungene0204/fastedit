import { Schema } from 'prosemirror-model';

// 일반 텍스트 문단만 다룬다. 서식은 교정 대상이 아니다.
export const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'text*',
      parseDOM: [{ tag: 'p' }, { tag: 'div' }, { tag: 'li' }, { tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }],
      toDOM: () => ['p', 0],
    },
    text: {},
  },
});

export function docFromText(text: string) {
  const paragraphs = text.split('\n').map((line) => schema.node('paragraph', null, line ? [schema.text(line)] : []));
  return schema.node('doc', null, paragraphs);
}
