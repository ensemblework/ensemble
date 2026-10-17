use base64::{Engine,engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey,Signature};
fn main()->Result<(),Box<dyn std::error::Error>> {
 let args:Vec<String>=std::env::args().collect();
 let config:serde_json::Value=serde_json::from_slice(&std::fs::read(&args[1])?)?;
 let public=String::from_utf8(STANDARD.decode(config["plugins"]["updater"]["pubkey"].as_str().unwrap())?)?;
 let key=PublicKey::decode(&public)?;
 for path in &args[2..] {
  let signature=std::fs::read_to_string(format!("{path}.sig"))?;
  let signature=String::from_utf8(STANDARD.decode(signature.trim())?)?;
  key.verify(&std::fs::read(path)?,&Signature::decode(&signature)?,true)?;
  println!("Verified signature: {}",std::path::Path::new(path).file_name().unwrap().to_string_lossy());
 }
 Ok(())
}
