import random
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))
from ledger import Ledger  # noqa: E402


def test_no_balance_goes_negative():
    rng = random.Random(7)
    ledger = Ledger()
    moved = 0
    for _ in range(2000):
        account = rng.choice("abc")
        amount = rng.randint(1, 50)
        if rng.random() < 0.5:
            ledger.deposit(account, amount)
            moved += amount
        else:
            try:
                ledger.withdraw(account, amount)
                moved -= amount
            except ValueError:
                pass
        assert all(b >= 0 for b in ledger.balances.values())
    assert ledger.total() == moved


def test_overdraw_is_refused():
    ledger = Ledger()
    ledger.deposit("a", 5)
    with pytest.raises(ValueError):
        ledger.withdraw("a", 6)
