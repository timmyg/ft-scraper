const Nightmare = require('nightmare');
const cheerio = require('cheerio');
const moment = require('moment');
const async = require('async');
const throng = require('throng');
const schedule = require('node-schedule');
const _ = require('underscore');
const colors = require('colors/safe');
import { Auction, Bidding, Item } from './models';
console.log(colors.red('starting...'));
const selector = "#DataTable";
var MongoClient = require('mongodb').MongoClient
let db, dbAuctions, dbItems;
// how many processes we should cluster
var WORKERS = process.env.WEB_CONCURRENCY || 1;
// expected memory requirements of your application’s processes - defaults to 512
// process.env.WEB_MEMORY || 512;
const docs = 100;
let skip = 0;

require('dotenv').config()

function startFunction() {
  console.log("startFunction")
  console.log()
  MongoClient.connect(process.env.MONGO_URL, function (err, db) {
    if (err) throw err
    dbAuctions = db.collection('auctions')
    dbItems = db.collection('items')
    console.log('connected...')
    refresh();
  })
}

throng({
  workers: WORKERS, // Number of workers (cpu count)
  lifetime: Infinity, // ms to keep cluster alive
  grace: 4000, // ms grace period after worker SIGTERM (5000)
  // master: masterFunction, // Function to call when starting the master process
  start: startFunction // Function to call when starting the worker processes
});

throng((id) => {
  console.log(`Started worker ${id}`);
});


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
let startTime;

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
      let estimatedTimeSeconds = gActiveItemLinks / gI * moment().diff(startTime, 's');
      const durationMinutes = estimatedTimeSeconds / 60;
      const durationMinutesRounded = Math.round(100*durationMinutes)/100;
      console.log(`${gI}/${gActiveItemLinks} (estimated ${durationMinutesRounded} minutes)`)

      let $ = cheerio.load(table);
      let bids: number = 0, highBidder: string, amount: number, isEnded: boolean;
      try { bids = Number($("tr:nth-child(2) td:nth-child(4)").first().text().trim()) } catch (e) {}
      try { highBidder = $("tr:nth-child(2) td:nth-child(5)").first().text().trim() } catch (e) {}
      try {
        let amountString = $("tr:nth-child(2) td:nth-child(6)").first().text().trim();
        if (amountString.indexOf("=") > -1) {
          amountString = amountString.substring(amountString.indexOf("=") + 1).trim();
        }
        amount = Number(amountString);
      } catch (e) {}
      try {
        let isEndedString = $("tr:nth-child(2) td:nth-child(8)").first().text().trim();
        if (isEndedString == "ended") {
          isEnded = true;
        }
      } catch (e) {}
      let bidding = new Bidding(highBidder, amount, bids, new Date(), isEnded);
      dbItems.updateOne({_id: item._id}, {"$set": {bidding: bidding}}, (a, b) => {
        console.log("^", item.link)
        return cb();
      });
    }).catch((error) => {
        console.error('importItem error', error);
        return cb();
    });
}

function getRandom() {
  // random number between 1 and 5
  const random = _.random(1, 5)
  switch(random) {
   case 1: {
      // ended 60 mins ago to now, not isEnded ()
      console.log(colors.red('*(@#$&(*@&$(*&(*&#)@($*@)#(*$)#@*$'));
      // dbItems.find({"auction.end": {$gte: new Date()}, "bidding": {"$ne": null}}, { link: 1, _id: 1}).skip(skip).limit(docs).sort( { "bidding.lastUpdated": 1 } ).toArray((err, refreshedItemLinks) => {

      // break;
   }
   case 2: {
      // ending now to next hour, 300
      console.log(colors.green('*(@#$&(*@&$(*&(*&#)@($*@)#(*$)#@*$'));
      // break;
   }
   case 3: {
      // ending in an hour to 4 hours
      console.log(colors.yellow('*(@#$&(*@&$(*&(*&#)@($*@)#(*$)#@*$'));
      // break;
   }
   case 4: {
      // ending in 4 hours to 12 hours
      console.log(colors.cyan('*(@#$&(*@&$(*&(*&#)@($*@)#(*$)#@*$'));
      // break;
   }
   case 5: {
      // ending in to 12 hours to forever
      console.log(colors.magenta('*(@#$&(*@&$(*&(*&#)@($*@)#(*$)#@*$'));
      // break;
   }
  }
}

function refreshAllItems(cb) {
  skip = skip + docs;
  // const thisSkip = skip();
  console.log("_-^-_-'-__-^-_-'-__-^-_-'-__-^-_-'-__-^-_-'-_")
  console.log("_-^-_-'-__-^-_ refreshAllItems", skip, "_-^-_-'-__-^-_")
  console.log("_-^-_-'-__-^-_-'-__-^-_-'-__-^-_-'-__-^-_-'-_")
  // TODO how will this refresh "recently" completed items
  // find active items that have not been refreshed yet, order by auction end ascending
  // dbItems.find({"auction.end": {$gte: new Date()}, "bidding": {"$eq": null}}, { link: 1, _id: 1}).skip(skip).limit(docs).sort( { "auction.end": 1 } ).toArray((err, nonRefreshedItemLinks) => {
    // find active items that have been refreshed, order by last refreshed ascending
  dbItems.find({"auction.end": {$gte: new Date()}, "bidding": {"$ne": null}}, { link: 1, _id: 1}).skip(skip).limit(docs).sort( { "bidding.lastUpdated": 1 } ).toArray((err, refreshedItemLinks) => {
    let activeItemLinks = refreshedItemLinks;
    console.log(`refreshing ${activeItemLinks.length} items`)
    gActiveItemLinks = activeItemLinks.length;
    startTime = moment();
    async.eachLimit(activeItemLinks, 3, importItem, function(err, result) {
    // async.eachSeries(activeItemLinks, importItem, function(err, result) {
      const duration = moment().diff(startTime, 's');
      const durationMinutes = duration / 60;
      const durationMinutesRounded = Math.round(100*durationMinutes)/100;
      console.log(`done refreshing items! it took ${durationMinutesRounded} minutes`)
      // db.close();
      return cb();
    });
  });
  // });
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
        const startTime = moment();
        async.eachSeries(newAuctionIds, importAuction, function(err, result) {
            return cb();
        });
      })
    })
    .catch((error) => {
      console.error('getNewAuctions error:', error);
    });

}

function refresh() {
  // refreshAllItems(() => {
  // });
  // console.log("forevering")
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
    getCincyAreaAuctions();
}

function getCincyAreaAuctions() {
  const allAuctions = process.env.AUCTIONS_LINK; // comma separated
  let auctionsLinks = allAuctions.split(",");
  console.log("auctionsLinks.length", auctionsLinks.length)
  async.eachSeries(auctionsLinks, getNewAuctions, function(err, result) {
      const duration = moment().diff(startTime, 's');
      const durationMinutes = duration / 60;
      const durationMinutesRounded = Math.round(100*durationMinutes)/100;
      console.log(`done refreshing auctions! it took ${durationMinutesRounded} minutes`)
      // db.close();
  });
}
