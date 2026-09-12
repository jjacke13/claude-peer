{
  description = "claude-peer — A2A endpoint for a live Claude Code session";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  outputs = { nixpkgs, ... }:
    let system = "x86_64-linux"; pkgs = nixpkgs.legacyPackages.${system};
    in { devShells.${system}.default = pkgs.mkShell { packages = [ pkgs.bun ]; }; };
}
