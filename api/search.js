// Vercel Serverless Function
// 国立国会図書館（NDL）APIで日本の本をタイトル検索してISBNを返す

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const title = (req.query.title || '').trim();
  if (!title) return res.json([]);

  try {
    // mediatype不要：category=図書 をXMLパース時にフィルタする
    const ndlUrl = `https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(title)}&cnt=50`;
    const ndlRes = await fetch(ndlUrl);
    if (!ndlRes.ok) throw new Error(`NDL ${ndlRes.status}`);

    const xml = await ndlRes.text();
    const books = parseNDLXml(xml);
    const withIsbn = books.filter(b => b.isbn);

    if (withIsbn.length > 0) return res.json(withIsbn.slice(0, 10));

    // NDLでISBNが取れなければ Google Books にフォールバック
    const gbBooks = await searchGoogleBooks(title);
    return res.json(gbBooks);

  } catch (e) {
    try {
      return res.json(await searchGoogleBooks(title));
    } catch {
      return res.status(500).json([]);
    }
  }
}

// ========================
// NDL XML パーサー
// ========================
function parseNDLXml(xml) {
  const books = [];

  // <item>〜</item> を一つずつ処理
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];

    // 図書カテゴリのみ（記事・新聞を除外）
    if (!block.includes('<category>図書</category>')) continue;

    // タイトル（<title> の最初の出現）
    const titleM = block.match(/<title>([^<]+)<\/title>/);
    if (!titleM) continue;
    const title = titleM[1].trim();

    // 著者（最初の dc:creator）
    const creatorM = block.match(/<dc:creator>([^<]+)<\/dc:creator>/);
    const author = creatorM ? creatorM[1].replace(/,\s*\d{4}-(\d{4})?/g, '').trim() : '';

    // ISBN抽出：dcndl:ISBN 属性を持つ dc:identifier
    // 例: <dc:identifier xsi:type="dcndl:ISBN">978-4-10-101005-2</dc:identifier>
    let isbn = '';
    const idRegex = /<dc:identifier[^>]*xsi:type="dcndl:ISBN[^"]*"[^>]*>([^<]+)<\/dc:identifier>/g;
    let idM;
    while ((idM = idRegex.exec(block)) !== null) {
      const raw = idM[1].replace(/-/g, '').trim();
      if (/^978\d{10}$/.test(raw)) { isbn = raw; break; }        // ISBN-13 優先
      if (/^\d{9}[\dX]$/.test(raw) && !isbn) isbn = raw;        // ISBN-10 を保持
    }

    books.push({ title, author, isbn });
  }

  return books;
}

// ========================
// Google Books フォールバック
// ========================
async function searchGoogleBooks(title) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(title)}&maxResults=20&printType=books`;
  const data = await fetch(url).then(r => r.json());
  return (data.items || []).map(item => {
    const info = item.volumeInfo || {};
    const ids = info.industryIdentifiers || [];
    const isbn = (ids.find(i => i.type === 'ISBN_13') || ids.find(i => i.type === 'ISBN_10') || {}).identifier || '';
    if (!isbn) return null;
    return { title: info.title || '', author: (info.authors || []).join('、'), isbn };
  }).filter(Boolean).slice(0, 10);
}
