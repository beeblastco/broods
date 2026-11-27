import Spec.Channels.Twins.Support

namespace Spec.Channels.Wavechannels1.Base

open Lean Spec

def get (value : Json) (key : String) : Json :=
  (value.getObjVal? key).toOption.getD Twin.undefinedJson

def missing (value : Json) : Bool := value == Twin.undefinedJson
def nullish (value : Json) : Bool := missing value || value == .null
def jsTruthy (value : Json) : Bool := !missing value && truthy value
def text (value : Json) : String := value.getStr?.toOption.getD ""
def items (value : Json) : List Json := (arr? value).getD []
def fnJson (name : String := "") : Json := Json.mkObj [("$fn", toJson name)]
def undef : Json := Twin.undefinedJson
def num (n : Nat) : Json := toJson n

/-- Drops trailing decimal zeros, so an exact product prints as JavaScript prints it. -/
def normalize (n : JsonNumber) : JsonNumber := Id.run do
  let mut mantissa := n.mantissa
  let mut exponent := n.exponent
  for _ in [0:n.exponent] do
    if exponent > 0 && mantissa % 10 == 0 then
      mantissa := mantissa / 10
      exponent := exponent - 1
  return ⟨mantissa, exponent⟩

def mulNum (a b : JsonNumber) : JsonNumber :=
  normalize ⟨a.mantissa * b.mantissa, a.exponent + b.exponent⟩

def addNum (a b : JsonNumber) : JsonNumber :=
  let exponent := max a.exponent b.exponent
  let scale (n : JsonNumber) : Int := n.mantissa * (10 ^ (exponent - n.exponent) : Nat)
  normalize ⟨scale a + scale b, exponent⟩

def asNum (value : Json) : JsonNumber :=
  match value with
  | .num n => n
  | _ => 0

end Spec.Channels.Wavechannels1.Base
