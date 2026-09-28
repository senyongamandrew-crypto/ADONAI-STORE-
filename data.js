/* ============ Adonai Store OPS — seed data (UGX) ============ */
/* Replace this with live API data when the store backend is connected. */

const SEED_PRODUCTS = [
  { id: "PRD-001", name: "Adonai Anointing Oil 250ml",   category: "Faith",      price: 25000,  stock: 42,  reorderAt: 15 },
  { id: "PRD-002", name: "Study Bible (ESV, Leather)",    category: "Books",      price: 85000,  stock: 11,  reorderAt: 10 },
  { id: "PRD-003", name: "Worship Essentials Hoodie",     category: "Apparel",    price: 65000,  stock: 8,   reorderAt: 12 },
  { id: "PRD-004", name: "Adonai Mug — Be Still",         category: "Home",       price: 18000,  stock: 64,  reorderAt: 20 },
  { id: "PRD-005", name: "Wall Art — Psalm 23",           category: "Home",       price: 45000,  stock: 5,   reorderAt: 8 },
  { id: "PRD-006", name: "Kids Devotional Cards",         category: "Kids",       price: 15000,  stock: 0,   reorderAt: 15 },
  { id: "PRD-007", name: "Prayer Journal — Hardcover",    category: "Books",      price: 30000,  stock: 27,  reorderAt: 10 },
  { id: "PRD-008", name: "Adonai Cap — Embroidered",      category: "Apparel",    price: 22000,  stock: 19,  reorderAt: 10 }
];

const SEED_CUSTOMERS = [
  { id: "CUS-001", name: "Nakato Sarah",   phone: "+256 772 001 234", area: "Kampala"  },
  { id: "CUS-002", name: "Muwonge David",  phone: "+256 701 442 890", area: "Entebbe"  },
  { id: "CUS-003", name: "Achieng Grace",  phone: "+256 753 908 112", area: "Jinja"    },
  { id: "CUS-004", name: "Okello Brian",   phone: "+256 784 330 556", area: "Gulu"     },
  { id: "CUS-005", name: "Nanyonga Ruth",  phone: "+256 709 112 004", area: "Mukono"   },
  { id: "CUS-006", name: "Kato Emmanuel",  phone: "+256 772 555 789", area: "Kampala"  }
];

const METHODS = ["MTN MoMo", "Airtel Money", "Cash", "Card"];
const STATUSES = ["pending", "paid", "shipped", "delivered", "cancelled"];

/* Deterministic-ish seed orders spread over the last 14 days */
function generateSeedOrders() {
  const orders = [];
  const now = new Date();
  let n = 1042;
  const combos = [
    [["PRD-001", 2], ["PRD-004", 1]],
    [["PRD-002", 1]],
    [["PRD-003", 1], ["PRD-008", 1]],
    [["PRD-004", 3]],
    [["PRD-007", 1], ["PRD-001", 1]],
    [["PRD-005", 1]],
    [["PRD-006", 2], ["PRD-007", 1]],
    [["PRD-008", 2]]
  ];
  for (let d = 13; d >= 0; d--) {
    const perDay = 2 + ((14 - d) % 4); // 2–5 orders per day, spreading statuses
    for (let i = 0; i < perDay; i++) {
      const date = new Date(now);
      date.setDate(now.getDate() - d);
      date.setHours(8 + ((d * 3 + i * 5) % 12), (d * 7 + i * 13) % 60, 0, 0);

      const items = combos[(d + i) % combos.length].map(([pid, qty]) => {
        const p = SEED_PRODUCTS.find(x => x.id === pid);
        return { productId: pid, name: p.name, qty, price: p.price };
      });
      const total = items.reduce((s, it) => s + it.price * it.qty, 0);

      // older orders more likely delivered/done; recent ones pending/paid
      let status;
      if (d > 7)       status = (i % 5 === 4) ? "cancelled" : "delivered";
      else if (d > 3)  status = ["delivered", "shipped", "paid"][(d + i) % 3];
      else if (d > 1)  status = ["paid", "shipped", "pending"][(d + i) % 3];
      else             status = ["pending", "paid"][(d + i) % 2];

      orders.push({
        id: "ORD-" + (n++),
        customerId: SEED_CUSTOMERS[(d + i * 2) % SEED_CUSTOMERS.length].id,
        items, total,
        method: METHODS[(d * 2 + i) % METHODS.length],
        status,
        createdAt: date.toISOString()
      });
    }
  }
  return orders.reverse(); // newest first
}

/* Payments derived from paid+ orders */
function derivePayments(orders, customers) {
  return orders
    .filter(o => ["paid", "shipped", "delivered"].includes(o.status))
    .map(o => {
      const c = customers.find(cu => cu.id === o.customerId);
      return {
        id: "PAY-" + o.id.slice(4),
        orderId: o.id,
        customer: c ? c.name : o.customerId,
        method: o.method,
        amount: o.total,
        date: o.createdAt
      };
    });
}
