using System.Globalization;
using System.Text.Json.Nodes;

namespace Vibe.Api.Features.D1;

// coefficient * 10^exponent, with no trailing coefficient zeros. All arithmetic is exact.
// The exponent remains a decimal string, so even an enormous exponent needs only linear storage.
internal readonly record struct ExactNumber(bool Negative, string Digits, string Exponent)
{
    public string Canonical => Digits == "0" ? "0" : (Negative ? "-" : "") + Digits + "e" + Exponent;

    public static bool TryRead(JsonNode? node, out ExactNumber number)
    {
        number = default;
        if (node is not JsonValue) return false;
        string raw = node.ToJsonString();
        if (raw.Length == 0 || raw[0] != '-' && !char.IsAsciiDigit(raw[0])) return false;
        number = Parse(raw);
        return true;
    }
    static ExactNumber Parse(string raw)
    {
        int exponentAt = raw.IndexOfAny(['e', 'E']);
        ReadOnlySpan<char> mantissa = raw.AsSpan(0, exponentAt < 0 ? raw.Length : exponentAt);
        bool negative = mantissa[0] == '-';
        if (negative) mantissa = mantissa[1..];
        int decimalAt = mantissa.IndexOf('.');
        int fractionDigits = decimalAt < 0 ? 0 : mantissa.Length - decimalAt - 1;
        string allDigits = decimalAt < 0 ? mantissa.ToString() : string.Concat(mantissa[..decimalAt], mantissa[(decimalAt + 1)..]);
        int first = 0;
        while (first < allDigits.Length && allDigits[first] == '0') first++;
        // Zero is independent of its exponent, including exponents larger than any machine integer.
        if (first == allDigits.Length) return new ExactNumber(false, "0", "0");
        int last = allDigits.Length - 1;
        while (allDigits[last] == '0') last--;
        int trailingZeros = allDigits.Length - last - 1;
        string exponent = exponentAt < 0 ? "0" : NormalizeExponent(raw.AsSpan(exponentAt + 1));
        exponent = AddSmall(exponent, trailingZeros - fractionDigits);
        return new ExactNumber(negative, allDigits.Substring(first, last - first + 1), exponent);
    }
    public bool TryInt32(out int value)
    {
        value = 0;
        if (Digits == "0") return true;
        // A normalized negative exponent is fractional. A larger positive exponent cannot fit Int32.
        if (Exponent[0] == '-' || Exponent.Length > 2 || Digits.Length > 10) return false;
        int power = int.Parse(Exponent, NumberStyles.None, CultureInfo.InvariantCulture);
        if (Digits.Length + power > 10) return false;
        long magnitude = 0;
        foreach (char digit in Digits) magnitude = magnitude * 10 + digit - '0';
        for (int i = 0; i < power; i++) magnitude *= 10;
        long signed = Negative ? -magnitude : magnitude;
        if (signed < int.MinValue || signed > int.MaxValue) return false;
        value = (int)signed;
        return true;
    }
    static string NormalizeExponent(ReadOnlySpan<char> exponent)
    {
        bool negative = exponent[0] == '-';
        if (negative || exponent[0] == '+') exponent = exponent[1..];
        int first = 0;
        while (first < exponent.Length && exponent[first] == '0') first++;
        if (first == exponent.Length) return "0";
        return (negative ? "-" : "") + exponent[first..].ToString();
    }
    static string AddSmall(string exponent, int delta)
    {
        if (delta == 0) return exponent;
        bool leftNegative = exponent[0] == '-';
        string left = leftNegative ? exponent[1..] : exponent;
        bool rightNegative = delta < 0;
        string right = Math.Abs((long)delta).ToString(CultureInfo.InvariantCulture);
        if (leftNegative == rightNegative) return (leftNegative ? "-" : "") + AddMagnitude(left, right);
        int comparison = left.Length.CompareTo(right.Length);
        if (comparison == 0) comparison = string.CompareOrdinal(left, right);
        if (comparison == 0) return "0";
        bool negative = comparison > 0 ? leftNegative : rightNegative;
        string difference = comparison > 0 ? SubtractMagnitude(left, right) : SubtractMagnitude(right, left);
        return (negative ? "-" : "") + difference;
    }
    static string AddMagnitude(string left, string right)
    {
        int length = Math.Max(left.Length, right.Length);
        char[] result = new char[length + 1];
        int carry = 0;
        for (int i = 0; i < length; i++)
        {
            int sum = carry + (i < left.Length ? left[left.Length - i - 1] - '0' : 0) + (i < right.Length ? right[right.Length - i - 1] - '0' : 0);
            result[length - i] = (char)('0' + sum % 10); carry = sum / 10;
        }
        result[0] = (char)('0' + carry);
        return carry == 0 ? new string(result, 1, length) : new string(result);
    }
    // Inputs are positive normalized magnitudes and left > right.
    static string SubtractMagnitude(string left, string right)
    {
        char[] result = new char[left.Length];
        int borrow = 0;
        for (int i = 0; i < left.Length; i++)
        {
            int digit = left[left.Length - i - 1] - '0' - borrow - (i < right.Length ? right[right.Length - i - 1] - '0' : 0);
            if (digit < 0) { digit += 10; borrow = 1; } else borrow = 0;
            result[result.Length - i - 1] = (char)('0' + digit);
        }
        int first = 0;
        while (first < result.Length - 1 && result[first] == '0') first++;
        return new string(result, first, result.Length - first);
    }
}
