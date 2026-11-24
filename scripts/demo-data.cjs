'use strict';
// Made-up shop data for demos, screenshots and tests. Nothing here is real.
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const FIRST = ['Somchai', 'Malee', 'Anan', 'Kanya', 'Niran', 'Pim', 'Arthit', 'Darin', 'Emma', 'Liam', 'Olivia', 'Noah', 'Mia', 'Lucas', 'Aria', 'Kenji', 'Yuki', 'Sara', 'Omar', 'Lena', 'สมชาย', 'มาลี', 'อนันต์', 'กัญญา'];
const LAST = ['Srisuk', 'Wongsa', 'Chaiyo', 'Boonmee', 'Smith', 'Garcia', 'Tanaka', 'Kim', 'Novak', 'Rossi', 'Silva', 'Meyer', 'ใจดี', 'มีสุข'];
const CITIES = ['Bangkok', 'Chiang Mai', 'Phuket', 'Khon Kaen', 'Hat Yai', 'Tokyo', 'Berlin', 'Lisbon', 'Austin', 'Seoul'];
const CATS = [[1, 'Coffee', 'Beans, ground and capsules'], [2, 'Tea', 'Leaf tea and herbal blends'], [3, 'Brewing', 'Kettles, drippers and grinders'], [4, 'Cups', 'Mugs, glasses and tumblers'], [5, 'Snacks', 'Cookies and dried fruit']];
const PRODUCTS = {
  1: ['Doi Chang Medium Roast', 'Ethiopia Yirgacheffe', 'House Espresso Blend', 'Decaf Colombia', 'Cold Brew Pack'],
  2: ['Thai Milk Tea Mix', 'Jasmine Green', 'Earl Grey', 'Butterfly Pea', 'Oolong No. 12'],
  3: ['Gooseneck Kettle', 'V60 Dripper', 'Hand Grinder', 'French Press 600ml', 'Paper Filters x100'],
  4: ['Stoneware Mug', 'Double Wall Glass', 'Travel Tumbler', 'Espresso Cup Set', 'Enamel Camp Mug'],
  5: ['Butter Cookies', 'Dried Mango', 'Almond Biscotti', 'Coconut Chips', 'Dark Chocolate Bar'],
};
const STATUS = ['paid', 'paid', 'paid', 'shipped', 'shipped', 'delivered', 'delivered', 'delivered', 'cancelled', 'refunded'];

function day(base, plus) { const d = new Date(base); d.setUTCDate(d.getUTCDate() + plus); return d; }
const iso = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

function build({ customers = 400, orders = 2500 } = {}) {
  seed = 42;
  const categories = CATS.map(([id, name, description]) => ({ id, name, description }));
  const products = [];
  let pid = 1;
  for (const [cat, names] of Object.entries(PRODUCTS)) for (const name of names) {
    products.push({ id: pid, sku: `SKU-${String(pid).padStart(4, '0')}`, name, category_id: +cat, price: (int(9, 120) * 10 + 0.5) / 1, stock: int(0, 400), active: rnd() > 0.1, created_at: iso(day('2024-01-01', int(0, 300))) });
    pid++;
  }
  const custs = [];
  for (let i = 1; i <= customers; i++) {
    const f = pick(FIRST); const l = pick(LAST);
    const ascii = /^[A-Za-z]+$/.test(f + l);
    custs.push({ id: i, name: `${f} ${l}`, email: ascii ? `${f}.${l}${i}@example.com`.toLowerCase() : `user${i}@example.com`, city: pick(CITIES), tier: rnd() > 0.85 ? 'gold' : rnd() > 0.6 ? 'silver' : 'basic', phone: rnd() > 0.2 ? `08${int(1, 9)}-${int(100, 999)}-${int(1000, 9999)}` : null, created_at: iso(day('2024-01-01', int(0, 600))) });
  }
  const ords = [];
  const items = [];
  let itemId = 1;
  for (let i = 1; i <= orders; i++) {
    const c = pick(custs);
    const n = int(1, 4);
    let total = 0;
    for (let k = 0; k < n; k++) {
      const p = pick(products);
      const qty = int(1, 3);
      total += p.price * qty;
      items.push({ id: itemId++, order_id: i, product_id: p.id, quantity: qty, unit_price: p.price });
    }
    ords.push({ id: i, customer_id: c.id, status: pick(STATUS), total: Math.round(total * 100) / 100, note: rnd() > 0.92 ? pick(['gift wrap please', 'leave at door', 'call before delivery', 'ส่งด่วน']) : null, ordered_at: iso(day('2025-01-01', int(0, 320))) });
  }
  return { categories, products, customers: custs, orders: ords, order_items: items };
}

module.exports = { build };
