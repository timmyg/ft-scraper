
let Nightmare = require('nightmare');
let nightmareInstance = Nightmare();
let cheerio = require('cheerio');
let moment = require('moment');
let async = require('async');
const schedule = require('node-schedule');
let _ = require('underscore');
const Hapi = require('hapi');
import { Auction, Bidding, Item } from './models';
console.log('starting...')
const selector = "#DataTable";
var MongoClient = require('mongodb').MongoClient
let db, dbAuctions, dbItems;

require('dotenv').config()

function importAuction(auctionId, cb) {
  let auctionLink = `${process.env.SCRAPE_HOST}/cgi-bin/mnprint.cgi?${auctionId}`;
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
        link = `${process.env.SCRAPE_HOST}/cgi-bin/mnlist.cgi?${auctionId}/${itemId}`
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
  Nightmare()
    .goto(item.link)
    .wait('#DataTable')
    .evaluate(() => {
      return document!.querySelector('#DataTable')!.innerHTML;
    })
    .end()
    .then((table) => {
      // console.log("table", table)
      gI++;

      //  estimate time
      let estimatedTimeSeconds = gActiveItemLinks / gI * moment().diff(start, 's');
      const durationMinutes = estimatedTimeSeconds / 60;
      const durationMinutesRounded = Math.round(100*durationMinutes)/100;
      console.log(`${gI}/${gActiveItemLinks} (estimated ${durationMinutesRounded} minutes)`)

      let $ = cheerio.load(table);
      let bids: number = 0, highBidder: string, amount: number;
      try { bids = Number($("tr:nth-child(2) td:nth-child(4)").first().text().trim()) } catch (e) {}
      try { highBidder = $("tr:nth-child(2) td:nth-child(5)").first().text().trim() } catch (e) {}
      try {
        let amountString = $("tr:nth-child(2) td:nth-child(6)").first().text().trim();
        if (amountString.indexOf("=") > -1) {
          amountString = amountString.substring(amountString.indexOf("=") + 1).trim();
        }
        amount = Number(amountString);
      } catch (e) {}
      // if (!bids) { return cb(); }
      let bidding = new Bidding(highBidder, amount, bids, new Date());
      dbItems.updateOne({_id: item._id}, {"$set": {bidding: bidding}}, (a, b) => {
        console.log("^", item.link)
        return cb();
      });
    }).catch((error) => {
        console.error('importItem error', error);
        return cb();
    });
}

function refreshAllItems(cb) {
  // TODO how will this refresh "recently" completed items
  // find active items that have not been refreshed yet, order by auction end ascending
  dbItems.find({"auction.end": {$gte: new Date()}, "bidding": {"$eq": null}}, { link: 1, _id: 1}).sort( { "auction.end": 1 } ).limit(100).toArray((err, nonRefreshedItemLinks) => {
    // find active items that have been refreshed, order by last refreshed ascending
    dbItems.find({"auction.end": {$gte: new Date()}, "bidding": {"$ne": null}}, { link: 1, _id: 1}).sort( { "bidding.lastUpdated": 1 } ).limit(100).toArray((err, refreshedItemLinks) => {
      let activeItemLinks = nonRefreshedItemLinks.concat(refreshedItemLinks);
      console.log(`refreshing ${activeItemLinks.length} items`)
      gActiveItemLinks = activeItemLinks.length;
      start = moment();
      async.eachLimit(activeItemLinks, 5, importItem, function(err, result) {
      // async.eachSeries(activeItemLinks, importItem, function(err, result) {
        const duration = moment().diff(start, 's');
        const durationMinutes = duration / 60;
        const durationMinutesRounded = Math.round(100*durationMinutes)/100;
        console.log(`done refreshing items! it took ${durationMinutesRounded} minutes`)
        // db.close();
        return cb();
      });
    });
  });
}
function getNewAuctions(cityAuctionsLink, cb) {
  console.log("-_-_~_-_-_-_~_-_-_-_~_-_-_-_~_-_-_-_~_-_-_-_~_-_-_-_~_-_")
  console.log(cityAuctionsLink)
  console.log("-_-_~_-_-_-_~_-_-_-_~_-_-_-_~_-_-_-_~_-_-_-_~_-_-_-_~_-_")
  Nightmare()
    .goto(cityAuctionsLink)
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
            // const duration = moment().diff(start, 's');
            // const durationMinutes = duration / 60;
            // const durationMinutesRounded = Math.round(100*durationMinutes)/100;
            // console.log(`done refreshing auctions! it took ${durationMinutesRounded} minutes`)
            // db.close();
            return cb();
        });
      })
    })
    .catch((error) => {
      console.error('getNewAuctions error:', error);
    });

}

function refresh() {
  refreshAllItems(() => {
  });

  // async.forever(
  //   (next) => {
  //     console.log("^ ^ ^ ^^ ^^ ^ ^^ ^^^ ^REEEFRESH")
  //     refreshAllItems(() => {
  //       console.log("- - - - - - - -  REEEFRESH AGAIN")
  //       next()
  //     });
  //   }, (err) => {
  //     console.log("forever loop error:", err)
  //   }
  // );

  // schedule.scheduleJob({hour: 5, minute: 10}, () => {
  //   getNewAuctions();
  // });

  // getCincyAreaAuctions();
}

function getCincyAreaAuctions() {
  const allAuctions = process.env.AUCTIONS_LINK; // comma separated
  let auctionsLinks = allAuctions.split(",");
  console.log("auctionsLinks.length", auctionsLinks.length)
  async.eachSeries(auctionsLinks, getNewAuctions, function(err, result) {
      const duration = moment().diff(start, 's');
      const durationMinutes = duration / 60;
      const durationMinutesRounded = Math.round(100*durationMinutes)/100;
      console.log(`done refreshing auctions! it took ${durationMinutesRounded} minutes`)
      // db.close();
  });
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
