"""Gestion des comptes Piano Compagnon (à lancer sur le serveur).

  python utilisateurs.py ajouter <identifiant> "<Nom affiché>"
  python utilisateurs.py motdepasse <identifiant>
  python utilisateurs.py liste
"""
import getpass
import sys

import main


def ask_password() -> str:
    while True:
        p1 = getpass.getpass("Mot de passe : ")
        if len(p1) < 6:
            print("6 caractères minimum.")
            continue
        if p1 != getpass.getpass("Confirmer : "):
            print("Les deux saisies diffèrent.")
            continue
        return p1


def run(argv: list[str]) -> None:
    main.init_db()
    if len(argv) >= 3 and argv[0] == "ajouter":
        main.create_user(argv[1], argv[2], ask_password())
        print(f"Compte « {argv[1]} » créé.")
    elif len(argv) >= 2 and argv[0] == "motdepasse":
        print("Mot de passe changé." if main.set_password(argv[1], ask_password()) else "Compte introuvable.")
    elif argv[:1] == ["liste"]:
        with main.db() as cur:
            cur.execute("SELECT login, name FROM pc_users ORDER BY login")
            for login, name in cur.fetchall():
                print(f"{login:20} {name}")
    else:
        print(__doc__)


if __name__ == "__main__":
    run(sys.argv[1:])
