export class Bidding {
  constructor(
    private highBidder: string = '',
    private amount: number,
    private bids: number,
    private lastUpdated: any,
    private isEnded: boolean,
  ) {}
}
