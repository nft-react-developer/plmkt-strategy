export interface GammaToken {
  token_id: string;
  outcome:  string;
  price:    string;
  winner?:  boolean;
}

export interface GammaMarket {
  conditionId: string;
  question:    string;
  volume:      string;
  tokens:      GammaToken[];
}