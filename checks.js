(async () => {
  await load('/work/lab.js');
  await load('/work/solution.js');
  const c = db.getSiblingDB('hw2_validation');
  await c.dropDatabase();
  await c.createCollection('products');
  await installValidator(c);
  let passed = 0;
  const check = (name, condition) => {
    if (!condition) throw new Error(name);
    print('PASS ' + name);
    passed++;
  };
  try {
    const valid = () => ({
      _id: 'schema-check', name: 'Test', category: 'test', price: NumberDecimal('0'),
      variants: [{size: 'L', stock: NumberLong('2147483648')}]
    });
    await c.products.insertOne(valid());
    check('zero decimal price and int64 stock accepted', await c.products.countDocuments({}) === 1);
    await c.products.deleteMany({});
    const invalid = [
      ...['_id', 'name', 'category', 'price', 'variants'].map(field => [
        'required ' + field, p => {delete p[field]; return p;}
      ]),
      ['duplicate sizes', p => ({...p, variants: [p.variants[0], {size: 'L', stock: NumberInt(1)}]})],
      ['fractional stock', p => ({...p, variants: [{size: 'L', stock: 1.5}]})],
      ['negative price', p => ({...p, price: NumberDecimal('-0.01')})],
      ['missing size', p => ({...p, variants: [{stock: NumberInt(1)}]})],
      ['missing stock', p => ({...p, variants: [{size: 'L'}]})],
      ['non-array variants', p => ({...p, variants: 'L'})],
      ['non-object variant', p => ({...p, variants: [null]})]
    ];
    for (const [name, mutate] of invalid) {
      let code;
      try {await c.products.insertOne(mutate(valid()));} catch (e) {code = e.code;}
      check(name + ' rejected with code 121', code === 121);
    }
    await c.products.insertOne({...valid(), variants: [
      {size: 'L', stock: NumberInt(1)}, {size: 'l', stock: NumberInt(2)}
    ]});
    check('case-sensitive sizes allowed', await c.products.countDocuments({}) === 1);
    check('search category is case-sensitive', (await searchProducts(c, {category: 'TEST', size: 'L', qty: 1})).length === 0);
    check('search size is case-sensitive', (await searchProducts(c, {category: 'test', size: 'L', qty: 2})).length === 0);

    const orders = db.getSiblingDB('hw2');
    const before = EJSON.stringify({
      products: await orders.products.find({}).sort({_id: 1}).toArray(),
      orders: await orders.orders.find({}).sort({_id: 1}).toArray()
    });
    const request = {operationId: 'purchase-001', userId: 2500,
      items: [{sku: 'A', size: 'M', qty: 2}, {sku: 'B', size: 'L', qty: 1}]};
    check('main purchase exists', !!(await orders.orders.findOne({_id: request.operationId})));
    for (const [name, changed] of [
      ['userId', {...request, userId: 2501}],
      ['sku', {...request, items: [{...request.items[0], sku: 'C'}, request.items[1]]}],
      ['size', {...request, items: [{...request.items[0], size: 'L'}, request.items[1]]}],
      ['item order', {...request, items: [...request.items].reverse()}]
    ]) {
      let code;
      try {await purchase(changed);} catch (e) {code = e.code;}
      check('changed ' + name + ' rejected with REQUEST_CONFLICT', code === 'REQUEST_CONFLICT');
    }
    check('conflicts preserve products and orders', EJSON.stringify({
      products: await orders.products.find({}).sort({_id: 1}).toArray(),
      orders: await orders.orders.find({}).sort({_id: 1}).toArray()
    }) === before);
    await writeProbe(c, 'repeat', 'same message');
    await writeProbe(c, 'repeat', 'same message');
    check('probe upsert replay creates one document', await c.probe.countDocuments({}) === 1);
    check('missing probe returns null', await readProbe(c, 'missing') === null);
    print('COMPLETE extra: ' + passed);
  } finally {
    await c.dropDatabase();
  }
})().catch(e => {console.error(e); quit(1);});
