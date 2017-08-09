let Nightmare = require('nightmare');
let cheerio = require('cheerio');
let moment = require('moment');
let async = require('async');
let _ = require('underscore');
const Hapi = require('hapi');
let nightmare = Nightmare({ show: false });
let cincyAuctions = 'http://www.bidfta.com/search?utf8=%E2%9C%93&keywords=&search%5Btagged_with%5D=&location=Cincinnati%2C+Oh&seller=&button=';
import { Auction, Bidding, Item } from './models';
console.log('starting...')
const selector = "#DataTable";
var MongoClient = require('mongodb').MongoClient
let db, dbAuctions, dbItems;

// mongodb://scraper:e6KFHJ4BxcDAfr7j2MjXPuK8wqAN9@ds119302.mlab.com:19302/ft-auctions

function importAuction(auctionId, cb) {
  let auctionLink = `https://bid.bidfta.com/cgi-bin/mnprint.cgi?${auctionId}`;
  Nightmare()
    .goto(auctionLink)
    .wait('#DataTable')
    .evaluate(() => {
      return document!.querySelector('#wrapper')!.innerHTML;
    })
    .end()
    .then((table) => {
      let $ = cheerio.load(table);
      let auctionTime = $("p").first().text()
      let auctionLocationId = auctionId.replace(/[^A-Za-z]/g, "").replace(/i+$/, "");
      let momentTime = auctionTime.substr(auctionTime.lastIndexOf("-") + 1)
      let auctionMomentTime = moment(momentTime, "MMMM Do, YYYY h:mm A z")
      let newAuction = new Auction(auctionId, auctionLink, auctionMomentTime.toDate(), auctionLocationId);
      $('#DataTable tr:not(:first-child)').each(function(i, rowElem) {
        let $item = cheerio.load(rowElem);
        let itemId, msrp, link;
        // descriptions
        let brand, description, specs, model, additionalInfo;
        try { itemId = $item("td").first().text().replace(/\W/g, '').trim() } catch (e) {}
        try { msrp = Number($item("b:contains('MSRP')")[0].nextSibling.nodeValue.replace(/[^0-9.]/g, '')) } catch (e) {}
        try { description = $item("b:contains('Item Description')")[0].nextSibling.nodeValue } catch (e) {}
        try { brand = $item("b:contains('Brand')")[0].nextSibling.nodeValue } catch (e) {}
        try { specs = $item("b:contains('Specifications')")[0].nextSibling.nodeValue } catch (e) {}
        try { additionalInfo = $item("b:contains('Additional Info')")[0].nextSibling.nodeValue } catch (e) {}
        try { model = $item("b:contains('Model')")[0].nextSibling.nodeValue } catch (e) {}
        link = `https://bid.bidfta.com/cgi-bin/mnlist.cgi?${auctionId}/${itemId}`
        let item: Item = new Item( itemId, auctionId, msrp, description, link, additionalInfo, brand, model, specs, newAuction);
        let cleanItem = item.cleanup();
        console.log("+")
        dbItems.insert(cleanItem);
      });
      // console.log(auctionId, 'complete');
      // add to db
      dbAuctions.insert(newAuction);
      cb();
    });
}

let gI = 0;
let gActiveItemLinks = 0;
let start;

function importItem(item, cb) {
  console.log("import item:", item.link)
  Nightmare().goto(item.link)
  .wait('#DataTable')
  .evaluate(() => {
    return document!.querySelector('#DataTable')!.innerHTML;
  })
  .end()
  .then((table) => {
    gI++;

    //  estimate time
    let estimatedTimeSeconds = gActiveItemLinks / gI * moment().diff(start, 's');
    const durationMinutes = estimatedTimeSeconds / 60;
    const durationMinutesRounded = Math.round(100*durationMinutes)/100;
    console.log(`${gI}/${gActiveItemLinks} (estimated ${durationMinutesRounded} minutes)`)

    let $ = cheerio.load(table);
    let bids: number = 0, highBidder: string = "", amount: number = 0;
    try { bids = Number($("tr:nth-child(2) td:nth-child(4)").first().text().trim()) } catch (e) {}
    try { highBidder = $("tr:nth-child(2) td:nth-child(5)").first().text().trim() } catch (e) {}
    try {
      let amountString = $("tr:nth-child(2) td:nth-child(6)").first().text().trim();
      if (amountString.indexOf("=") > -1) {
        amountString = amountString.substring(amountString.indexOf("=") + 1).trim();
      }
      amount = Number(amountString);
    } catch (e) {}
    if (!bids) { return cb(); }
    let bidding = new Bidding(highBidder, amount, bids, new Date());
    dbItems.updateOne({_id: item._id}, {"$set": {bidding: bidding}}, (a, b) => {
      console.log("^", item.link)
      return cb();
    });
  }).catch((error) => {
      console.error('an error has occurred: ' + error);
  });
}

function refreshAllItems() {
  // TODO how will this refresh "recently" completed items
  // find active items that have not been refreshed yet, order by auction end ascending
  dbItems.find({"auction.end": {$gte: new Date()}, "bidding": {"$eq": null}}, { link: 1, _id: 1}).sort( { "auction.end": 1 } ).toArray((err, nonRefreshedItemLinks) => {
    // find active items that have been refreshed, order by last refreshed ascending
    dbItems.find({"auction.end": {$gte: new Date()}, "bidding": {"$ne": null}}, { link: 1, _id: 1}).sort( { "bidding.lastUpdated": 1 } ).toArray((err, refreshedItemLinks) => {
      let activeItemLinks = nonRefreshedItemLinks.concat(refreshedItemLinks);
      console.log(`refreshing ${activeItemLinks.length} items`)
      gActiveItemLinks = activeItemLinks.length;
      start = moment();
      // async.eachLimit(activeItemLinks, 10, importItem, function(err, result) {
      async.eachSeries(activeItemLinks, importItem, function(err, result) {
        const duration = moment().diff(start, 's');
        const durationMinutes = duration / 60;
        const durationMinutesRounded = Math.round(100*durationMinutes)/100;
        console.log(`done refreshing items! it took ${durationMinutesRounded} minutes`)
        db.close();
      });
    });
  });
}
function getNewAuctions() {
  nightmare
    .goto(cincyAuctions)
    .wait('.row.finePrint')
    .evaluate(() => {
      return [...document.querySelectorAll('.row.currentAuctionsListings .auction > a')].map(el => (el as any).href.substring((el as any).href.indexOf("?")+1));
    })
    .end()
    .then((pageAuctionIds) => {
      // let existingAuctionIds = ['sadf'];
      // TODO weed out auctions already imported
      dbAuctions.find({}, { id: 1 }).toArray((err, existingAuctions) => {
        let existingAuctionsIds = _.pluck(existingAuctions, 'id')
        let newAuctionIds = _.difference(pageAuctionIds, existingAuctionsIds);
        const start = moment();
        async.eachSeries(newAuctionIds, importAuction, function(err, result) {
            // if result is true then every auction exists
            const duration = moment().diff(start, 's');
            const durationMinutes = duration / 60;
            const durationMinutesRounded = Math.round(100*durationMinutes)/100;
            console.log(`done refreshing auctions! it took ${durationMinutesRounded} minutes`)
            db.close();
        });
      })
    })
    .catch((error) => {
      console.error('Search failed:', error);
    });

}

function refresh() {
  // getNewAuctions();
  refreshAllItems();
}

MongoClient.connect(process.env.MONGO_URL, function (err, db) {
  if (err) throw err
  dbAuctions = db.collection('auctions')
  dbItems = db.collection('items')

  console.log('connected...')

  const server = new Hapi.Server();
  server.connection({ port: process.env.PORT || 5000 });
  server.start((err) => {
      if (err) {
          throw err;
      }
      console.log('Server running at:', server.info.uri);
      refresh();
  });

  server.route({
      method: 'GET',
      path: '/',
      handler: function (request, reply) {
          reply('Hello!');
      }
  });
})
