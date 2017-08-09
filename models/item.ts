import { Auction, Bidding } from '.';

export class Item {
  private bidding: Bidding;
  constructor(
    private id: string,
    private auctionId: string,
    private msrp: number,
    private description: string,
    private link: string,
    private additionalInfo: string,
    private brand: string,
    private model: string,
    private specs: string,
    private auction: Auction
  ) {}

  cleanup() {
    let ctxt = this;
    console.log('cleanup', this)
    for (var property in ctxt) {
      // console.log('property:', property)
      if (ctxt.hasOwnProperty(property) && ctxt[property] != undefined && property != "_id" && property != "msrp" && property != "auction") {
        let fieldValue: any = ctxt[property] + '';
        let cleanProp = fieldValue.replace(": ", "").trim();
        ctxt[property] = cleanProp;
      }
    }
    console.log('cleaned-up', this)
    return ctxt;
  }
}
