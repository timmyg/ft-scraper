const Nightmare = require('nightmare');
const cheerio = require('cheerio');
const moment = require('moment');
const async = require('async');
const throng = require('throng');
const schedule = require('node-schedule');
const _ = require('underscore');
const chalk = require('chalk');
import { Auction, Bidding, Item, Query } from './models';
console.log(chalk.green('starting...'));
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

function startFunction(idd) {
  process.on('SIGTERM', function() {
    console.log(chalk.magenta(`Worker ${idd} exiting`));
    console.log('Cleanup here');
    process.exit();
  });

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

let workerId;
let workerColor;
throng((id) => {
  console.log(`Started worker ${id}`);
  workerId = id;
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
  console.log(chalk[workerColor]("import item:", item.link))
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
      console.log(chalk[workerColor](`${gI}/${gActiveItemLinks} (estimated ${durationMinutesRounded} minutes)`))

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
        console.log(chalk[workerColor]("^", item.link))
        return cb();
      });
    }).catch((error) => {
        console.error('importItem error', error);
        return cb();
    });
}

function getQuery() {
  console.log(chalk.bgGreen('------------------------- workerId -------------------------', workerId));

  let q = new Query();
  q.sort = { "bidding.lastUpdated": 1 }
  q.projection = { link: 1, _id: 1 }
  const cases = 5;
  const now = moment().toDate();
  // get a worker id between 1 and 5
  workerId = workerId % cases;
  switch(workerId) {
   case 0: {
      // ended 60 mins ago to now, not isEnded (), endTime desc
      q.queryColor = "red";
      workerColor = q.queryColor;
      console.log(chalk[workerColor]('*(@#$&(*@&$(*&(*&-_- past hour _-_#)@($*@)#(*$)#@*$'));
      const oneHourAgo = moment().subtract(1, "h").toDate()
      q.query = {
        "auction.end": {
            $gte: oneHourAgo,
            $lt: now
        }
      }
      return q;
   }
   case 1: {
      // ending now to next hour, endTime desc
      q.queryColor = "green";
      workerColor = q.queryColor;
      console.log(chalk[workerColor]('*(@#$&(*@&$(*&(*&-_- next four hours _-_#)@($*@)#(*$)#@*$'));
      const hourHoursFromNow = moment().add(4, "h").toDate()
      q.query = {
        "auction.end": {
            $gte: now,
            $lt: hourHoursFromNow
        }
      }
      return q;
   }
   case 2: {
      // ending in an hour to 4 hours, endTime desc
      q.queryColor = "yellow";
      workerColor = q.queryColor;
      console.log(chalk[workerColor]('*(@#$&(*@&$(*&(*&-_- 1-8 hours _-_#)@($*@)#(*$)#@*$'));
      const oneHourFromNow = moment().add(1, "h").toDate()
      const eightHoursFromNow = moment().add(8, "h").toDate()
      q.query = {
        "auction.end": {
            $gte: oneHourFromNow,
            $lt: eightHoursFromNow
        }
      }
      return q;
   }
   case 3: {
      // ending in 4 hours to 12 hours
      q.queryColor = "cyan";
      workerColor = q.queryColor;
      console.log(chalk[workerColor]('*(@#$&(*@&$(*&(*&-_- 4-12 hours _-_#)@($*@)#(*$)#@*$'));
      const fourHoursFromNow = moment().add(4, "h").toDate()
      const twelveHoursFromNow = moment().add(12, "h").toDate()
      q.query = {
        "auction.end": {
            $gte: fourHoursFromNow,
            $lt: twelveHoursFromNow
        }
      }
      return q;
   }
   case 4: {
      // ending in to 12 hours to forever
      q.queryColor = "magenta";
      workerColor = q.queryColor;
      console.log(chalk[workerColor]('*(@#$&(*@&$(*&(*&-_- 12+ hours _-_#)@($*@)#(*$)#@*$'));
      const twelveHoursFromNow = moment().add(12, "h").toDate()
      q.query = {
        "auction.end": {
            $gte: twelveHoursFromNow
        }
      }
      return q;
   }
  }
}

function refreshAllItems(cb) {
  skip = skip + docs;
  const q = getQuery();

  dbItems.find(q.query || {}, q.projection || {}).limit(5).sort( q.sort ).toArray((err, items) => {
    console.log(chalk[workerColor](`refreshing ${items.length} items`))
    gActiveItemLinks = items.length;
    startTime = moment();
    async.eachLimit(items, 3, importItem, function(err, result) {
      const duration = moment().diff(startTime, 's');
      const durationMinutes = duration / 60;
      const durationMinutesRounded = Math.round(100*durationMinutes)/100;
      console.log(chalk[workerColor](`done refreshing items! it took ${durationMinutesRounded} minutes`))
      process.exit();
      return cb();
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
  refreshAllItems(() => {
  });
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
    // getCincyAreaAuctions();
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
