import {metadata} from '../server/http-handler.mjs';
export default function handler(_req,res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify(metadata));
}
