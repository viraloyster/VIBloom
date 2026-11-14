"""A ledger of balances that must never go negative."""


class Ledger:
    def __init__(self):
        self.balances = {}

    def deposit(self, account, amount):
        if amount <= 0:
            raise ValueError("amount must be positive")
        self.balances[account] = self.balances.get(account, 0) + amount

    def withdraw(self, account, amount):
        if amount <= 0 or amount > self.balances.get(account, 0):
            raise ValueError("insufficient balance")
        self.balances[account] -= amount

    def total(self):
        return sum(self.balances.values())
