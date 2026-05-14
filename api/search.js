// Vercel Serverless Function
// 国立国会図書館（NDL）APIを使って日本の本をタイトル検索し、ISBNを返す

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const title = (req.query.title || '').trim();
  if (!title) {
    return res.json([]);
  }

  try {
    // 国立国会図書館サーチAPI（図書のみ: mediatype=1）
    const ndlUrl = `https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(title)}&cnt=30&mediatype=1`;
    const ndlRes = await fetch(ndlUrl, {
      headers: { 'Accept': 'application/xml' }
    });

    if (!ndlRes.ok) {
      throw new Error(`NDL API error: ${ndlRes.status}`);
    }

    const xmlText = await ndlRes.text();
    const books = parseNDLXml(xmlText);

    // ISBNがある本に絞る
    const withIsbn = books.filter(b => b.isbn);

    // ISBNなしでも件数が少なければGoogle Booksで補完
    if (withIsbn.length === 0) {
      const googleBooks = await searchGoogleBooks(title);
      return res.json(googleBooks);
    }

    return res.json(withIsbn.slice(0, 10));

  } catch (e) {
    // NDLが失敗したらGoogle Booksにフォールバック
    try {
      const googleBooks = await searchGoogleBooks(title);
      return res.json(googleBooks);
    } catch (e2) {
      return res.status(500).json({ error: e2.message });
    }
  }
}

// ========================
// NDL XML パーサー
// ========================
function parseNDLXml(xml) {
  const books = [];

  // <item>...</item> を全部抽出
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;

  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const item = itemMatch[1];

    // タイトル
    const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const rawTitle = titleMatch ? titleMatch[1].trim() : '';

    // 著者
    const creatorMatch = item.match(/<dc:creator>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dc:creator>/);
    const author = creatorMatch ? creatorMatch[1].trim() : '';

    // ISBN（xsi:type="dcndl:ISBN" の dc:identifier を探す）
    let isbn = '';
    const identifierRegex = /<dc:identifier[^>]*>([\s\S]*?)<\/dc:identifier>/g;
    let idMatch;
    while ((idMatch = identifierRegex.exec(item)) !== null) {
      const surrounding = item.substring(idMatch.index - 60, idMatch.index + idMatch[0].length);
      if (surrounding.includes('ISBN')) {
        const candidate = idMatch[1].replace(/-/g, '').trim();
        // ISBN-13 を優先
        if (/^978\d{10}$/.test(candidate)) {
          isbn = candidate;
          break;
        }
        // ISBN-10 も受け付ける
        if (/^\d{10}$/.test(candidate) && !isbn) {
          isbn = candidate;
        }
      }
    }

    if (rawTitle) {
      books.push({ title: rawTitle, author, isbn });
    }
  }

  return books;
}

// ========================
// Google Books フォールバック
// ========================
async function searchGoogleBooks(title) {
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(title)}&maxResults=20&printType=books`;
  const res = await fetch(url);
  const data = await res.json();
  const items = data.items || [];

  return items.map(item => {
    const info = item.volumeInfo || {};
    const ids = info.industryIdentifiers || [];
    const isbn13 = ids.find(i => i.type === 'ISBN_13')?.identifier;
    const isbn10 = ids.find(i => i.type === 'ISBN_10')?.identifier;
    const isbn = isbn13 || isbn10 || '';
    if (!isbn) return null;
    return {
      title: info.title || '',
      author: (info.authors || []).join('、'),
      isbn
    };
  }).filter(Boolean).slice(0, 10);
}
