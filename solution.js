globalThis.installValidator = async c => c.runCommand({
  collMod: 'products',
  validationLevel: 'strict',
  validationAction: 'error',
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'name', 'category', 'price', 'variants'],
      properties: {
        _id: {bsonType: 'string'},
        name: {bsonType: 'string'},
        category: {bsonType: 'string'},
        price: {bsonType: 'decimal', minimum: NumberDecimal('0')},
        variants: {
          bsonType: 'array',
          items: {
            bsonType: 'object',
            required: ['size', 'stock'],
            properties: {
              size: {bsonType: 'string'},
              stock: {bsonType: ['int', 'long'], minimum: 0}
            }
          }
        }
      }
    },
    $expr: {
      $cond: [
        {$isArray: '$variants'},
        {$eq: [
          {$size: '$variants'},
          {$size: {$setUnion: [
            {$map: {input: '$variants', as: 'variant', in: '$$variant.size'}},
            []
          ]}}
        ]},
        false
      ]
    }
  }
});

globalThis.searchProducts = async (c, {category, size, qty}) => c.products.find({
  category,
  variants: {$elemMatch: {size, stock: {$gte: qty}}}
}).collation({locale: 'simple'}).sort({_id: 1}).toArray();

globalThis.historyCursor = (c, {userId, status}) => c.orders.find({userId, status})
  .collation({locale: 'simple'}).sort({createdAt: -1, _id: 1}).limit(20);

globalThis.history = async (c, input) => historyCursor(c, input).toArray();
globalThis.historyIndex = {userId: 1, status: 1, createdAt: -1, _id: 1};
globalThis.usesHistoryHint = false;

globalThis.report = async (c, from, to) => c.orders.aggregate([
  {$match: {status: 'paid', createdAt: {$gte: from, $lt: to}}},
  {$unwind: '$items'},
  {$group: {
    _id: '$items.sku',
    qty: {$sum: '$items.qty'},
    revenue: {$sum: {$multiply: ['$items.qty', '$items.price']}}
  }},
  {$sort: {revenue: -1, _id: 1}},
  {$limit: 5},
  {$lookup: {from: 'products', localField: '_id', foreignField: '_id', as: 'product'}},
  {$unwind: '$product'},
  {$project: {_id: 0, sku: '$_id', name: '$product.name', qty: 1, revenue: 1}},
  {$sort: {revenue: -1, sku: 1}}
], {collation: {locale: 'simple'}}).toArray();

globalThis.purchase = async (request, trace = () => {}) => transaction(async c => {
  const existing = await c.orders.findOne(
    {_id: request.operationId}, {}, {collation: {locale: 'simple'}}
  );
  if (existing) {
    const sameRequest = Number(existing.userId) === Number(request.userId) &&
      existing.items.length === request.items.length &&
      existing.items.every((item, index) => {
        const requested = request.items[index];
        return item.sku === requested.sku && item.size === requested.size &&
          Number(item.qty) === Number(requested.qty);
      });
    if (!sameRequest) throw HWError('REQUEST_CONFLICT');
    return existing;
  }

  const items = [];
  for (const {sku, size, qty} of request.items) {
    const result = await c.products.updateOne({
      _id: sku,
      variants: {$elemMatch: {size, stock: {$gte: qty}}}
    }, {
      $inc: {'variants.$.stock': NumberInt(-Number(qty))}
    }, {collation: {locale: 'simple'}});
    trace({event: 'update_inside_transaction', sku,
      matched: result.matchedCount, modified: result.modifiedCount});
    if (result.matchedCount !== 1) throw HWError('ITEM_UNAVAILABLE');
    const product = await c.products.findOne({_id: sku}, {}, {collation: {locale: 'simple'}});
    items.push({sku, size, qty: NumberInt(Number(qty)), price: product.price});
  }

  const order = {
    _id: request.operationId,
    userId: NumberInt(Number(request.userId)),
    createdAt: new Date(),
    status: 'created',
    items
  };
  await c.orders.insertOne(order);
  return order;
});

globalThis.writeProbe = async (c, id, message) => c.probe.updateOne(
  {_id: id}, {$set: {message}},
  {upsert: true, writeConcern: {w: 'majority', j: true, wtimeout: 10000}}
);

globalThis.readProbe = async (c, id) => c.probe.findOne({_id: id});
